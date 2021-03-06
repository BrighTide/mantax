require('dotenv').config()

const _ = require('lodash')
const cors = require('cors')
const uuid = require('uuid')
const express = require('express')
const bodyParser = require('body-parser')
const { createClient } = require('@supabase/supabase-js')
const superagent = require('superagent')

const supabase = createClient(
   process.env.SUPABASE_URL,
   process.env.SUPABASE_KEY,
)

const app = express()

app.use(cors())
app.use(bodyParser.json())

const MANTAX_COOKIE_KEY = 'mantaxUserId'

const blogSlug = 'jarredfilmer'
// const blogSlug = 'astralcodexten'
Object.defineProperties({}, {})
app.post('/highlight', async (req, res) => {
   try {
      const user = await getOrCreateUser(req, res)

      if (user.isAdmin) {
      // Create outcome
         const { highlightInfo } = req.body
         const outcome = {
            outcomeId: uuid.v4(),
            outcomeType: 'highlight',
            substackCommentUserId: highlightInfo.substackCommentUserId,
            substackCommentId: highlightInfo.substackCommentId,
            substackPostId: highlightInfo.substackPostId,
         }

         const { error: insertOutcomeError } = await supabase
            .from('outcomes')
            .insert([outcome])
         if (insertOutcomeError) throw insertOutcomeError
      } else {
         console.log('Unauthorised attempt at creating highlight')
         res.status(401)
      }

      res.end()
   } catch (e) {
      console.log(e)
   }
})

app.post('/prediction', async (req, res) => {
   try {
      const user = await getOrCreateUser(req, res)

      // Create prediction
      const { predictionInfo } = req.body
      const prediction = {
         userId: user.userId,
         predictionId: uuid.v4(),
         substackCommentUserId: predictionInfo.substackCommentUserId,
         substackCommentId: predictionInfo.substackCommentId,
         substackPostId: predictionInfo.substackPostId,
         predictedOutcome: predictionInfo.predictedOutcome,
         predictionStatus: 'pending',
      }

      const { error: insertPredictionError } = await supabase
         .from('predictions')
         .insert([prediction])
      if (insertPredictionError) throw insertPredictionError

      res.end()
   } catch (e) {
      console.log(e)
   }
})

app.post('/reconcile', async (req, res) => {
   try {
      const user = await getOrCreateUser(req, res)

      const { reconcileInfo } = req.body

      // todo, this could be more efficiently joined in the db, rather than in server land

      const { error: getPredictionsError, data: predictions } = await supabase
         .from('predictions')
         .select('*')
         .eq('substackPostId', reconcileInfo.substackPostId)
      if (getPredictionsError) throw getPredictionsError

      // Go look at the article and reconcile any bans
      await processBans(req.body.reconcileInfo.substackPostId)

      const { error: getOutcomesError, data: outcomes } = await supabase
         .from('outcomes')
         .select('outcomeId, createdAt, outcomeType, substackCommentId')
         .eq('substackPostId', reconcileInfo.substackPostId)
      if (getOutcomesError) throw getOutcomesError

      const predictionUpdates = predictions.map((prediction) => {
         const outcome = outcomes.find(
            (outcome) => outcome.substackCommentId === prediction.substackCommentId,
         )

         // if there's no ban or highlight for comment
         // or comment outcome does not match prediction:
         // then prediction is wrong
         const predictionStatus = outcome?.outcomeType !== prediction.predictedOutcome
            ? 'wrong'
            : 'correct'

         return {
            ...prediction,
            predictionStatus,
         }
      })

      // currently no way to do batch update with supabase orm
      const { error: predictionUpdateError } = await supabase
         .from('predictions')
         .upsert(predictionUpdates)
      if (predictionUpdateError) throw predictionUpdateError

      console.log('predictions reconciled', predictionUpdates)

      res.end()
   } catch (e) {
      console.log(e)
   }
})

app.post('/user-data', async (req, res) => {
   try {
      const user = await getOrCreateUser(req, res)

      // TODO: Index and cache
      const { error: getPredictionsError, data: predictions } = await supabase
         .from('predictions')
         .select('*')
         .eq('userId', user.userId)
      if (getPredictionsError) throw error

      // TODO: Index and cache
      const { error: getOutcomesError, data: outcomes } = await supabase
         .from('outcomes')
         .select('*')
         .eq('substackPostId', req.body.substackPostId)
      if (getOutcomesError) throw error

      res.json({ predictions, outcomes })
   } catch (e) {
      console.log(e)
   }
   // get reconciliations
})

async function getOrCreateUser(req, res) {
   const userQuery = supabase
      .from('mantaxUsers')
      .select('userId, substackUserId, substackSubscriptionId, email, isAdmin')

   const cookieUserId = req.cookies ? req.cookies[MANTAX_COOKIE_KEY] : null

   if (cookieUserId) {
      console.log('mantaxUserId', cookieUserId)
      userQuery.eq('userId', cookieUserId)
   } else {
      const { userInfo } = req.body
      console.log('userInfo', userInfo)
      userQuery
         .eq('substackUserId', userInfo.substackUserId)
         .eq('substackSubscriptionId', userInfo.substackSubscriptionId)
         .eq('email', userInfo.email)
   }

   // Get user
   const { data: existingUsers, error: getUserError } = await userQuery
   if (getUserError) throw getUserError

   const existingUser = existingUsers[0]
   console.log(existingUser)

   if (existingUsers.length > 1) throw new Error('More than one user match')
   if (cookieUserId && existingUsers.length === 0) {
      throw new Error('Could not find match for mantax user id')
   }

   // Create user if none exists
   let user
   if (existingUser) {
      user = existingUser
   } else {
      user = await createUser(req.body.userInfo)
      res.cookie(MANTAX_COOKIE_KEY, user.userId)
   }

   return user
}

async function createUser(userInfo) {
   console.log('Creating user')

   const user = {
      userId: uuid.v4(),
      substackUserId: userInfo.substackUserId,
      email: userInfo.email,
      substackSubscriptionId: userInfo.substackSubscriptionId,
   }

   const { error } = await supabase.from('mantaxUsers').insert([user])
   if (error) throw error

   return user
}

async function processBans(postId) {
   // Comments come back to us in a tree
   const response = await superagent(
      `https://${blogSlug}.substack.com/api/v1/post/${postId}/comments?token=&all_comments=true&sort=oldest_first`,
   )

   // If no comments, stop here
   if (_.isEmpty(response.body) || !response.body.comments.length) return

   const unrollBans = (comment) => [
      ...comment.bans,
      ...comment.children.flatMap(unrollBans),
   ]
   const bans = response.body.comments.flatMap(unrollBans)

   const outcomes = bans.map((ban) => ({
      outcomeId: uuid.v4(),
      outcomeType: 'ban',
      substackCommentUserId: ban.user_id,
      substackCommentId: ban.comment_id,
      substackPostId: postId,
   }))

   console.log(`Inserting ${outcomes.length} bans`)

   const { error } = await supabase.from('outcomes').insert(outcomes)
   if (error) throw error
}

app.listen(8080, () => {
   console.log('Listening on port 8080')
})
