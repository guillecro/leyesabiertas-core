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
        const customForm = await CustomForm.get({ _id: req.body.customForm })
        const newDocument = await Document.create(req.body, customForm)
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
        // Check if it is published or not (draft)
        if (!document.published) {
          // It's a draft, check if the author is the user who requested it.
          if (!isTheAuthor) {
            // No, Then the user shouldn't be asking for this document.
            throw errors.ErrForbidden
          }
        }
        // Deliver the document
        res.status(status.OK).json({
          document: document,
          isAuthor: isTheAuthor
        })
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
          const comments = await Comment.getAll(query)
          // Send email
          notifier.sendDocumentEdited(comments, document.author.fullname, document.currentVersion.content.title)
        } else {
          // Update the version document
          await DocumentVersion.update(document.currentVersion._id, req.body.content, customForm)
        }
        // Update the document, with the correct customForm
        const updatedDocument = await Document.update(req.params.id, newDataDocument)
        res.status(status.OK).json(updatedDocument)
      } catch (err) {
        next(err)
      }
    })

// router.route('/:id/update/:field')
/**
     * @api {put} /documents/:idDocument/update/:field Updates the content a field of a document
     * @apiName updateDocumentField
     * @apiGroup Comments
     * @apiDescription Note: This is only intended when updating a state of a field after a comment was created and added to the text's state.
     *
     * The following should throw an error:
     *
     * - The <code>:field</code> is not part of the content of the document.
     * - The <code>:field</code> is not commentable.
     * - The text is being changed.
     * - More than one mark is being added to the state.
     * - The one and only mark (the modification) needs to be a comment.
     *
     * Please note that any logged user can modify a field but knowing that this is for comments, the validators are used so you cannot mess around with this.
     *
     * @apiPermission authenticated
     * @apiParam {string} content (Body) The state of the text editor
     */
// .put(
//   middlewares.checkId,
//   auth.keycloak.protect(),
//   async (req, res, next) => {
//     try {
//       // Get the document
//       const document = await Document.get({ _id: req.params.id })
//       const customForm = await CustomForm.get({ _id: document.customForm })
//       // Check if the field is part of the document
//       if (!Object.keys(customForm.fields).indexOf(req.params.field)) {
//         throw errors.ErrBadRequest(`The field ${req.params.field} doesn't belong to the schema`)
//       }
//       if (!customForm.fields.allowComments.indexOf(req.params.field)) {
//         // If the field is not inside the "allowComments" array, throw an error
//         throw errors.ErrBadRequest(`The field ${req.params.field} is not commentable`)
//       }
//       // Create a new hash of the document, that will be used to check the text consistency
//       let hashTextSaved = utils.hashDocumentText(document.currentVersion.content[req.params.field])
//       let hashTextState = utils.hashDocumentText(req.body)
//       if (hashTextSaved !== hashTextState) {
//         // If the text of the field is being changed, throw an error
//         throw errors.ErrBadRequest(`The content of the field is being changed`)
//       }
//       // We need to check if the change is indeed a commentary
//       // First we get an object with the Diff
//       let fieldChanges = utils.getJsonDiffs(req.body, document.currentVersion.content[req.params.field])
//       // Now we get *ALL* the changes
//       let theChanges = utils.getObjects(fieldChanges, 'type', '')
//       // There has to be only one change, and it should be the comments
//       if (theChanges.length !== 1) {
//         throw errors.ErrBadRequest(`None or more than one mark has been added to the text`, { changes: theChanges })
//       }
//       // And now, the only change allowed should be a mark of type "comment"
//       if (theChanges[0].type !== 'comment') {
//         throw errors.ErrBadRequest(`You can only comment on a text.`)
//       }
//       // If everythig is ok...
//       // Update the field
//       const updatedDocument = await DocumentVersion.updateField(document.currentVersion._id, req.params.field, req.body, customForm)
//       res.status(status.OK).json(updatedDocument)
//     } catch (err) {
//       next(err)
//     }
//   })

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
        const results = await Comment.getAll(query)
        res.status(status.OK).json(results)
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
        const document = await Document.get({ _id: req.params.id })
        const theComment = await Comment.get({ _id: req.params.idComment })
        // Check if the user is the author of the document
        if (!req.session.user._id.equals(document.author._id)) {
          throw errors.ErrForbidden // User is not the author
        }
        // Update the comment
        const commentResolved = await Comment.resolve({ _id: req.params.idComment })
        notifier.sendResolvedNotification(theComment.user.email, theComment.content, document.author.fullname, document.currentVersion.content.title)
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
            const document = await Document.get({ _id: req.params.id })
            const theComment = await Comment.get({ _id: req.params.idComment })
            notifier.sendLikeNotification(theComment.user.email, theComment.content, document.author.fullname, document.currentVersion.content.title)
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

module.exports = router
