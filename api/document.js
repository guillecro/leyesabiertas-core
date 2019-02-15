const status = require('http-status')
const express = require('express')
const { Types: { ObjectId } } = require('mongoose')
const Document = require('../db-api/document')
const DocumentVersion = require('../db-api/documentVersion')
const Community = require('../db-api/community')
const Comment = require('../db-api/comment')
const CustomForm = require('../db-api/customForm')
const Like = require('../db-api/like')
const router = express.Router()
const auth = require('../services/auth')
const errors = require('../services/errors')
const notifier = require('../services/notifier')
const middlewares = require('../services/middlewares')
const utils = require('../services/utils')

/**
 * @apiDefine admin User access only
 * User must be an admin (Keycloak)
 */

/**
 * @apiDefine accountable Accountable members only
 * User must be a member of the Accountable group (Keycloak)
 */

/**
 * @apiDefine authenticated Must be authenticated
 * User must be authenticated before accessing (Keycloak)
 */

router.route('/')
  /**
   * @api {get} /documents List
   * @apiName getDocuments
   * @apiDescription Returns a paginated list of -published- documents
   * @apiGroup Document
   */
  .get(
    async (req, res, next) => {
      try {
        let results = null
        // If it is null, just show the published documents
        results = await Document.list({ published: true }, {
          limit: req.query.limit,
          page: req.query.page
        })
        let today = new Date()
        results.docs.forEach((doc) => {
          doc.closed = today > new Date(doc.currentVersion.content.closingDate)
        })
        res.status(status.OK).json({
          results: results.docs,
          pagination: {
            count: results.total,
            page: results.page,
            limit: results.limit
          }
        })
      } catch (err) {
        next(err)
      }
    })
  /**
   * @api {post} /documents Create
   * @apiName postDocument
   * @apiDescription Creates a document and returns the created document. The author is not required to be sent on the body. API sets the author by itself.
   * @apiGroup Document
   * @apiPermission accountable
   */
  .post(
    auth.keycloak.protect('realm:accountable'),
    async (req, res, next) => {
      try {
        // Get the community, we will need it to check the permissions of an accountable
        const community = await Community.get()
        // check if the user reached the creation limit
        const documentsCount = await Document.countAuthorDocuments(req.session.user._id)
        if (documentsCount >= community.permissions.accountable.documentCreationLimit) {
          throw errors.ErrNotAuthorized(`Cannot create more documents (Creation limit reached: ${community.permissions.accountable.documentCreationLimit})`)
        }
        req.body.author = req.session.user._id
        // In the body of the request customForm will be a slug. It will be an id later.
        const customForm = await CustomForm.get({ slug: req.body.customForm })
        if (!customForm) {
          throw errors.ErrBadRequest('customForm')
        }
        const newDocument = await Document.create(req.body, customForm)
        // Set closing notification agenda
        notifier.setDocumentClosesNotification(newDocument._id, req.body.content.closingDate)
        // Send
        res.status(status.CREATED).send(newDocument)
      } catch (err) {
        next(err)
      }
    })

router.route('/my-documents')
  /**
     * @api {get} /my-documents List
     * @apiName getDocuments
     * @apiDescription Returns a paginated list of the users documents. Lists all kind of documents, no matter the state.
     * @apiGroup Document
     */
  .get(
    auth.keycloak.protect('realm:accountable'),
    async (req, res, next) => {
      try {
        let results = null
        // If it is null, just show the published documents
        results = await Document.list({ author: req.session.user._id }, {
          limit: req.query.limit,
          page: req.query.page
        })
        res.status(status.OK).json({
          results: results.docs,
          pagination: {
            count: results.total,
            page: results.page,
            limit: results.limit
          }
        })
      } catch (err) {
        next(err)
      }
    })

router.route('/:id')
  /**
   * @api {get} /documents/:id Get
   * @apiName getDocument
   * @apiDescription Returns the data of a document.
   * @apiGroup Document
   * @apiParam {String} id Documents ID.
   * @apiSuccess {String}  id Id of the document
   * @apiSuccess {String}  author  The user id of the author.
   * @apiSuccess {String}  published State of the document. If `false` is a draft and should not be public.
   * @apiSuccess {String}  customForm Id of the custom form
   * @apiSuccess {Date}  createdAt Date of creation
   * @apiSuccess {Date}  updatedAt Date of update
   * @apiSuccess {Object}  content Content of the document
   * @apiSuccess {String}  content.title Title of the document
   * @apiSuccess {String}  content.brief A brief of the document
   * @apiSuccess {Object}  content.fields The custom fields of the document, those were defined on the custom form.
   */
  .get(
    middlewares.checkId,
    async (req, res, next) => {
      try {
        const document = await Document.get({ _id: req.params.id })
        // No document?
        if (!document) throw errors.ErrNotFound('Document not found or doesn\'t exist')
        // Check if the user is the author
        const isTheAuthor = req.session.user ? req.session.user._id.equals(document.author._id) : false
        const isClosed = new Date() > new Date(document.currentVersion.content.closingDate)
        // Check if it is published or not (draft)
        if (!document.published) {
          // It's a draft, check if the author is the user who requested it.
          if (!isTheAuthor) {
            // No, Then the user shouldn't be asking for this document.
            throw errors.ErrForbidden
          }
        }
        document.closed = isClosed
        let payload = {
          document: document,
          isAuthor: isTheAuthor
        }
        // If the document is closed
        if (isClosed) {
          const contributionsData = await DocumentVersion.countContributions({ document: req.params.id })
          const contextualCommentsCount = await Comment.count({ document: req.params.id, decoration: { $ne: null } })
          payload.contributionsCount = contributionsData.contributionsCount
          payload.contributorsCount = contributionsData.contributorsCount
          payload.contextualCommentsCount = contextualCommentsCount
        }
        // Deliver the document
        res.status(status.OK).json(payload)
      } catch (err) {
        next(err)
      }
    })
  /**
   * @api {put} /documents/:id Update
   * @apiName putDocument
   * @apiDescription Modifies a document. You just need to send the changed fields. No need to send all the document.
   * @apiGroup Document
   * @apiPermission accountable
   * @apiParam {Number} id Documents ID.
   */
  .put(
    middlewares.checkId,
    auth.keycloak.protect('realm:accountable'),
    async (req, res, next) => {
      try {
        // Get the document
        const document = await Document.get({ _id: req.params.id })
        if (!document) {
          throw errors.ErrNotFound('Document not found')
        }
        // Check if the user is the author of the document
        if (!req.session.user._id.equals(document.author._id)) {
          throw errors.ErrForbidden // User is not the author
        }
        // First deal with the decorations! Comments needs to be updated!
        if (req.body.decorations && req.body.decorations.length > 0) {
          await Comment.updateDecorations(document.currentVersion._id, req.body.decorations)
        }
        let newDataDocument = {
          published: req.body.published,
          closed: req.body.closed
        }
        // Retrieve the version of the customForm that the document follows
        const customForm = await CustomForm.get({ _id: document.customForm })
        // Check if this will imply a new document version
        if (req.body.contributions && req.body.contributions.length > 0) {
          // Set the data to save
          const newVersionData = {
            document: document._id,
            version: document.currentVersion.version + 1,
            content: req.body.content,
            contributions: req.body.contributions
          }
          // Create the new version
          const versionCreated = await DocumentVersion.create(newVersionData, customForm)
          // Set the lastVersion recently created
          newDataDocument.currentVersion = versionCreated._id
          // Get the users that contributed
          let idsArray = req.body.contributions.map((id) => {
            return ObjectId(id)
          })
          let query = {
            _id: { $in: idsArray }
          }
          const comments = await Comment.getAll(query, true)
          // Send email
          comments.forEach((comment) => {
            notifier.sendCommentNotification('comment-contribution', comment._id)
          })
        } else {
          // Update the version document
          await DocumentVersion.update(document.currentVersion._id, req.body.content, customForm)
        }
        // Update the document, with the correct customForm
        const updatedDocument = await Document.update(req.params.id, newDataDocument)
        // Set document closes event
        if (req.body.content && req.body.content.closingDate) {
          notifier.setDocumentClosesNotification(updatedDocument.id, req.body.content.closingDate)
        }
        res.status(status.OK).json(updatedDocument)
      } catch (err) {
        next(err)
      }
    })

router.route('/:id/comments')
  /**
     * @api {get} /documents/:idDocument/comments Get an array of comments
     * @apiName getSomeComments
     * @apiGroup Comments
     * @apiDescription You can get an array of comments of a document, as long you provide the correct querystring. No querystring at all returns a BAD REQUEST error.
     * @apiParam {ObjectID(s)} [ids] A list of ObjectIds, separated by comma. Ex: <code>ids=commentI21,commentId2,commentId3</code>
     * @apiParam {String} [field] The name of the field that the comments belongs to
     */
  .get(
    middlewares.checkId,
    async (req, res, next) => {
      try {
        // If there are no query string, then throw an error
        if (!utils.checkIfAtLeastOneQuery(req.query, ['ids', 'field'])) {
          throw errors.ErrMissingQuerystring(['ids', 'field'])
        }
        // Prepare query
        let query = {
          document: req.params.id
        }
        // If there is a "ids" querystring.. add it
        if (req.query.ids) {
          const idsToArray = req.query.ids.split(',')
          let idsArray = idsToArray.map((id) => {
            return ObjectId(id)
          })
          query._id = { $in: idsArray }
        }
        // If there is a "field" querystring.. add it
        if (req.query.field) {
          query.field = req.query.field
          query.resolved = false
        }

        const mapPromises = (fn) => (array) => Promise.all(array.map(fn))

        let comments = await Comment.getAll(query, false)
          .then(mapPromises(
            async (comment) => {
              const likes = await Like.getAll({
                comment: ObjectId(comment._id)
              })

              return { ...comment.toJSON(), likes: (likes ? likes.length : 0) }
            }
          ))

        if (req.session.user) {
          comments = await mapPromises(
            async (comment) => {
              const like = await Like.get({
                user: ObjectId(req.session.user._id),
                comment: ObjectId(comment._id)
              })

              return { ...comment, isLiked: !!like }
            }
          )(comments)
        }
        return res.status(status.OK).json(comments)
      } catch (err) {
        next(err)
      }
    }
  )
  /**
   * @api {post} /documents/:id/:field/comments Create
   * @apiName createComment
   * @apiGroup Comments
   * @apiDescription Creates a comment on a specific field of a document.
   * @apiPermission authenticated
   * @apiParam {string} field (Body) The field of the document where the comment is being made
   * @apiParam {Number} comment (Body) The field of the document where the comment is being made
   * @apiExample {json} POST body
   * {
   *  "field": "authorName",
   *  "comment": "Nullam sit amet ipsum id metus porta rutrum in vel nibh. Sed efficitur quam urna, eget imperdiet libero ornare."
   * }
   */
  .post(
    middlewares.checkId,
    auth.keycloak.protect(),
    async (req, res, next) => {
      try {
        req.body.user = req.session.user._id // Set the user
        req.body.document = req.params.id // Set the document
        const document = await Document.get({ _id: req.params.id })
        if (!document) {
          // Document not found
          throw errors.ErrNotFound('Document not found')
        }
        // Document Found
        // Get the customForm
        const customForm = await CustomForm.get({ _id: document.customForm })
        if (!customForm.fields.allowComments.find((x) => { return x === req.body.field })) {
          // If the field is not inside the "allowComments" array, throw error
          throw errors.ErrInvalidParam(`The field ${req.body.field} is not commentable`)
        }

        if (document.currentVersion.content.closingDate) {
          const closingDate = new Date(document.currentVersion.content.closingDate)
          const nowDate = new Date()
          if (closingDate < nowDate) {
            // The document is closed, no more comments allowed
            throw errors.ErrClosed
          }
        }
        // Field is commentable
        // Create the body of the new comment
        let commentBody = {
          user: req.session.user._id,
          document: document._id,
          version: document.currentVersion._id,
          field: req.body.field,
          content: req.body.content,
          decoration: req.body.decoration || null
        }
        // Save the comment
        const newComment = await Comment.create(commentBody)
        await Document.addComment({ _id: req.params.id })
        // Return the comment with the ID
        res.status(status.CREATED).send(newComment)
      } catch (err) {
        next(err)
      }
    }
  )

router.route('/:id/comments/:idComment/resolve')
  /**
       * @api {post} /documents/:idDocument/comments/:idComment/resolve Resolve a comment of a document
       * @apiName resolveComment
       * @apiGroup Comments
       * @apiDescription Resolves a comment of a document. This only sets the value <code>resolved</code> of a comment
       *
       * The only one who can do this is the author of the document.
       *
       * @apiPermission accountable
       */
  .post(
    auth.keycloak.protect('realm:accountable'),
    async (req, res, next) => {
      try {
        const { idComment } = req.params
        const document = await Document.get({ _id: req.params.id })
        // Check if the user is the author of the document
        if (!req.session.user._id.equals(document.author._id)) {
          throw errors.ErrForbidden // User is not the author
        }
        // Update the comment
        const commentResolved = await Comment.resolve({ _id: req.params.idComment })
        notifier.sendCommentNotification('comment-resolved', idComment)
        res.status(status.OK).json(commentResolved)
      } catch (err) {
        next(err)
      }
    }
  )

router.route('/:id/comments/:idComment/like')
  /**
   * @api {post} /documents/:idDocument/comments/:idComment/like Like a comment of a document
   * @apiName likeComment
   * @apiGroup Comments
   * @apiDescription Likes a comment of a document
   * @apiPermission accountable
   *
   */
  .post(
    auth.keycloak.protect(),
    async (req, res, next) => {
      try {
        const userId = req.session.user._id
        const { idComment } = req.params

        const like = await Like.get({
          user: userId,
          comment: idComment
        })

        if (!like) {
          const document = await Document.get({ _id: req.params.id })
          const isTheAuthor = req.session.user ? req.session.user._id.equals(document.author._id) : false
          const createdLike = await Like.create({
            user: userId,
            comment: idComment
          })
          if (isTheAuthor) {
            notifier.sendCommentNotification('comment-liked', idComment)
          }
          res.json(createdLike)
        } else {
          await Like.remove(like._id)
          res.json(null)
        }
        res.status(status.OK)
      } catch (err) {
        next(err)
      }
    }
  )

router.route('/:id/comments/:idComment/reply')
  .post(
    middlewares.checkId,
    auth.keycloak.protect('realm:accountable'),
    async (req, res, next) => {
      try {
        const document = await Document.get({ _id: req.params.id })
        // Check if the user is the author of the document
        if (!req.session.user._id.equals(document.author._id)) {
          throw errors.ErrForbidden // User is not the author
        }
        // Update the comment
        const commentUpdated = await Comment.reply({ _id: req.params.idComment }, req.body.reply)
        res.status(status.OK).json(commentUpdated)
      } catch (err) {
        next(err)
      }
    }
  )

module.exports = router
