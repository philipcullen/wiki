const Model = require('objection').Model
const _ = require('lodash')
const JSBinType = require('js-binary').Type
const pageHelper = require('../helpers/page')
const path = require('path')
const fs = require('fs-extra')
const yaml = require('js-yaml')
const striptags = require('striptags')
const emojiRegex = require('emoji-regex')
const he = require('he')

/* global WIKI */

const frontmatterRegex = {
  html: /^(<!-{2}(?:\n|\r)([\w\W]+?)(?:\n|\r)-{2}>)?(?:\n|\r)*([\w\W]*)*/,
  legacy: /^(<!-- TITLE: ?([\w\W]+?) -{2}>)?(?:\n|\r)?(<!-- SUBTITLE: ?([\w\W]+?) -{2}>)?(?:\n|\r)*([\w\W]*)*/i,
  markdown: /^(-{3}(?:\n|\r)([\w\W]+?)(?:\n|\r)-{3})?(?:\n|\r)*([\w\W]*)*/
}

const punctuationRegex = /[!,:;/\\_+\-=()&#@<>$~%^*[\]{}"'|]+|(\.\s)|(\s\.)/ig
// const htmlEntitiesRegex = /(&#[0-9]{3};)|(&#x[a-zA-Z0-9]{2};)/ig

/**
 * Pages model
 */
module.exports = class Page extends Model {
  static get tableName() { return 'pages' }

  static get jsonSchema () {
    return {
      type: 'object',
      required: ['path', 'title'],

      properties: {
        id: {type: 'integer'},
        path: {type: 'string'},
        hash: {type: 'string'},
        title: {type: 'string'},
        description: {type: 'string'},
        isPublished: {type: 'boolean'},
        privateNS: {type: 'string'},
        publishStartDate: {type: 'string'},
        publishEndDate: {type: 'string'},
        content: {type: 'string'},
        contentType: {type: 'string'},

        createdAt: {type: 'string'},
        updatedAt: {type: 'string'}
      }
    }
  }

  static get relationMappings() {
    return {
      tags: {
        relation: Model.ManyToManyRelation,
        modelClass: require('./tags'),
        join: {
          from: 'pages.id',
          through: {
            from: 'pageTags.pageId',
            to: 'pageTags.tagId'
          },
          to: 'tags.id'
        }
      },
      links: {
        relation: Model.HasManyRelation,
        modelClass: require('./pageLinks'),
        join: {
          from: 'pages.id',
          to: 'pageLinks.pageId'
        }
      },
      author: {
        relation: Model.BelongsToOneRelation,
        modelClass: require('./users'),
        join: {
          from: 'pages.authorId',
          to: 'users.id'
        }
      },
      creator: {
        relation: Model.BelongsToOneRelation,
        modelClass: require('./users'),
        join: {
          from: 'pages.creatorId',
          to: 'users.id'
        }
      },
      editor: {
        relation: Model.BelongsToOneRelation,
        modelClass: require('./editors'),
        join: {
          from: 'pages.editorKey',
          to: 'editors.key'
        }
      },
      locale: {
        relation: Model.BelongsToOneRelation,
        modelClass: require('./locales'),
        join: {
          from: 'pages.localeCode',
          to: 'locales.code'
        }
      }
    }
  }

  $beforeUpdate() {
    this.updatedAt = new Date().toISOString()
  }
  $beforeInsert() {
    this.createdAt = new Date().toISOString()
    this.updatedAt = new Date().toISOString()
  }

  /**
   * Cache Schema
   */
  static get cacheSchema() {
    return new JSBinType({
      id: 'uint',
      authorId: 'uint',
      authorName: 'string',
      createdAt: 'string',
      creatorId: 'uint',
      creatorName: 'string',
      description: 'string',
      isPrivate: 'boolean',
      isPublished: 'boolean',
      publishEndDate: 'string',
      publishStartDate: 'string',
      render: 'string',
      tags: [
        {
          tag: 'string',
          title: 'string'
        }
      ],
      title: 'string',
      toc: 'string',
      updatedAt: 'string'
    })
  }

  /**
   * Inject page metadata into contents
   *
   * @returns {string} Page Contents with Injected Metadata
   */
  injectMetadata () {
    return pageHelper.injectPageMetadata(this)
  }

  /**
   * Get the page's file extension based on content type
   *
   * @returns {string} File Extension
   */
  getFileExtension() {
    return pageHelper.getFileExtension(this.contentType)
  }

  /**
   * Parse injected page metadata from raw content
   *
   * @param {String} raw Raw file contents
   * @param {String} contentType Content Type
   * @returns {Object} Parsed Page Metadata with Raw Content
   */
  static parseMetadata (raw, contentType) {
    let result
    switch (contentType) {
      case 'markdown':
        result = frontmatterRegex.markdown.exec(raw)
        if (result[2]) {
          return {
            ...yaml.safeLoad(result[2]),
            content: result[3]
          }
        } else {
          // Attempt legacy v1 format
          result = frontmatterRegex.legacy.exec(raw)
          if (result[2]) {
            return {
              title: result[2],
              description: result[4],
              content: result[5]
            }
          }
        }
        break
      case 'html':
        result = frontmatterRegex.html.exec(raw)
        if (result[2]) {
          return {
            ...yaml.safeLoad(result[2]),
            content: result[3]
          }
        }
        break
    }
    return {
      content: raw
    }
  }

  /**
   * Create a New Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async createPage(opts) {
    // -> Validate path
    if (opts.path.indexOf('.') >= 0 || opts.path.indexOf(' ') >= 0) {
      throw new WIKI.Error.PageIllegalPath()
    }

    // -> Check for page access
    if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
      locale: opts.locale,
      path: opts.path
    })) {
      throw new WIKI.Error.PageDeleteForbidden()
    }

    // -> Check for duplicate
    const dupCheck = await WIKI.models.pages.query().select('id').where('localeCode', opts.locale).where('path', opts.path).first()
    if (dupCheck) {
      throw new WIKI.Error.PageDuplicateCreate()
    }

    // -> Check for empty content
    if (!opts.content || _.trim(opts.content).length < 1) {
      throw new WIKI.Error.PageEmptyContent()
    }

    // -> Create page
    await WIKI.models.pages.query().insert({
      authorId: opts.user.id,
      content: opts.content,
      creatorId: opts.user.id,
      contentType: _.get(_.find(WIKI.data.editors, ['key', opts.editor]), `contentType`, 'text'),
      description: opts.description,
      editorKey: opts.editor,
      hash: pageHelper.generateHash({ path: opts.path, locale: opts.locale, privateNS: opts.isPrivate ? 'TODO' : '' }),
      isPrivate: opts.isPrivate,
      isPublished: opts.isPublished,
      localeCode: opts.locale,
      path: opts.path,
      publishEndDate: opts.publishEndDate || '',
      publishStartDate: opts.publishStartDate || '',
      title: opts.title,
      toc: '[]'
    })
    const page = await WIKI.models.pages.getPageFromDb({
      path: opts.path,
      locale: opts.locale,
      userId: opts.user.id,
      isPrivate: opts.isPrivate
    })

    // -> Save Tags
    if (opts.tags && opts.tags.length > 0) {
      await WIKI.models.tags.associateTags({ tags: opts.tags, page })
    }

    // -> Render page to HTML
    await WIKI.models.pages.renderPage(page)

    // -> Rebuild page tree
    await WIKI.models.pages.rebuildTree()

    // -> Add to Search Index
    const pageContents = await WIKI.models.pages.query().findById(page.id).select('render')
    page.safeContent = WIKI.models.pages.cleanHTML(pageContents.render)
    await WIKI.data.searchEngine.created(page)

    // -> Add to Storage
    if (!opts.skipStorage) {
      await WIKI.models.storage.pageEvent({
        event: 'created',
        page
      })
    }

    // -> Reconnect Links
    await WIKI.models.pages.reconnectLinks({
      locale: page.localeCode,
      path: page.path,
      mode: 'create'
    })

    return page
  }

  /**
   * Update an Existing Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async updatePage(opts) {
    // -> Fetch original page
    const ogPage = await WIKI.models.pages.query().findById(opts.id)
    if (!ogPage) {
      throw new Error('Invalid Page Id')
    }

    // -> Check for page access
    if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
      locale: opts.locale,
      path: opts.path
    })) {
      throw new WIKI.Error.PageUpdateForbidden()
    }

    // -> Check for empty content
    if (!opts.content || _.trim(opts.content).length < 1) {
      throw new WIKI.Error.PageEmptyContent()
    }

    // -> Create version snapshot
    await WIKI.models.pageHistory.addVersion({
      ...ogPage,
      isPublished: ogPage.isPublished === true || ogPage.isPublished === 1,
      action: 'updated'
    })

    // -> Update page
    await WIKI.models.pages.query().patch({
      authorId: opts.user.id,
      content: opts.content,
      description: opts.description,
      isPublished: opts.isPublished === true || opts.isPublished === 1,
      publishEndDate: opts.publishEndDate || '',
      publishStartDate: opts.publishStartDate || '',
      title: opts.title
    }).where('id', ogPage.id)
    let page = await WIKI.models.pages.getPageFromDb({
      path: ogPage.path,
      locale: ogPage.localeCode,
      userId: ogPage.authorId,
      isPrivate: ogPage.isPrivate
    })

    // -> Save Tags
    await WIKI.models.tags.associateTags({ tags: opts.tags, page })

    // -> Render page to HTML
    await WIKI.models.pages.renderPage(page)

    // -> Update Search Index
    const pageContents = await WIKI.models.pages.query().findById(page.id).select('render')
    page.safeContent = WIKI.models.pages.cleanHTML(pageContents.render)
    await WIKI.data.searchEngine.updated(page)

    // -> Update on Storage
    if (!opts.skipStorage) {
      await WIKI.models.storage.pageEvent({
        event: 'updated',
        page
      })
    }

    // -> Perform move?
    if ((opts.locale && opts.locale !== page.localeCode) || (opts.path && opts.path !== page.path)) {
      await WIKI.models.pages.movePage({
        id: page.id,
        destinationLocale: opts.locale,
        destinationPath: opts.path,
        user: opts.user
      })
    } else {
      // -> Update title of page tree entry
      await WIKI.models.knex.table('pageTree').where({
        pageId: page.id
      }).update('title', page.title)
    }

    return page
  }

  /**
   * Move a Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise with no value
   */
  static async movePage(opts) {
    const page = await WIKI.models.pages.query().findById(opts.id)
    if (!page) {
      throw new WIKI.Error.PageNotFound()
    }

    // -> Check for source page access
    if (!WIKI.auth.checkAccess(opts.user, ['manage:pages'], {
      locale: page.sourceLocale,
      path: page.sourcePath
    })) {
      throw new WIKI.Error.PageMoveForbidden()
    }
    // -> Check for destination page access
    if (!WIKI.auth.checkAccess(opts.user, ['write:pages'], {
      locale: opts.destinationLocale,
      path: opts.destinationPath
    })) {
      throw new WIKI.Error.PageMoveForbidden()
    }

    // -> Check for existing page at destination path
    const destPage = await await WIKI.models.pages.query().findOne({
      path: opts.destinationPath,
      localeCode: opts.destinationLocale
    })
    if (destPage) {
      throw new WIKI.Error.PagePathCollision()
    }

    // -> Create version snapshot
    await WIKI.models.pageHistory.addVersion({
      ...page,
      action: 'moved'
    })

    const destinationHash = pageHelper.generateHash({ path: opts.destinationPath, locale: opts.destinationLocale, privateNS: opts.isPrivate ? 'TODO' : '' })

    // -> Move page
    await WIKI.models.pages.query().patch({
      path: opts.destinationPath,
      localeCode: opts.destinationLocale,
      hash: destinationHash
    }).findById(page.id)
    await WIKI.models.pages.deletePageFromCache(page)

    // -> Rebuild page tree
    await WIKI.models.pages.rebuildTree()

    // -> Rename in Search Index
    await WIKI.data.searchEngine.renamed({
      ...page,
      destinationPath: opts.destinationPath,
      destinationLocaleCode: opts.destinationLocale,
      destinationHash
    })

    // -> Rename in Storage
    if (!opts.skipStorage) {
      await WIKI.models.storage.pageEvent({
        event: 'renamed',
        page: {
          ...page,
          destinationPath: opts.destinationPath,
          destinationLocaleCode: opts.destinationLocale,
          destinationHash,
          moveAuthorId: opts.user.id,
          moveAuthorName: opts.user.name,
          moveAuthorEmail: opts.user.email
        }
      })
    }

    // -> Reconnect Links
    await WIKI.models.pages.reconnectLinks({
      sourceLocale: page.localeCode,
      sourcePath: page.path,
      locale: opts.destinationLocale,
      path: opts.destinationPath,
      mode: 'move'
    })
  }

  /**
   * Delete an Existing Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise with no value
   */
  static async deletePage(opts) {
    let page
    if (_.has(opts, 'id')) {
      page = await WIKI.models.pages.query().findById(opts.id)
    } else {
      page = await await WIKI.models.pages.query().findOne({
        path: opts.path,
        localeCode: opts.locale
      })
    }
    if (!page) {
      throw new Error('Invalid Page Id')
    }

    // -> Check for page access
    if (!WIKI.auth.checkAccess(opts.user, ['delete:pages'], {
      locale: page.locale,
      path: page.path
    })) {
      throw new WIKI.Error.PageDeleteForbidden()
    }

    // -> Create version snapshot
    await WIKI.models.pageHistory.addVersion({
      ...page,
      action: 'deleted'
    })

    // -> Delete page
    await WIKI.models.pages.query().delete().where('id', page.id)
    await WIKI.models.pages.deletePageFromCache(page)

    // -> Rebuild page tree
    await WIKI.models.pages.rebuildTree()

    // -> Delete from Search Index
    await WIKI.data.searchEngine.deleted(page)

    // -> Delete from Storage
    if (!opts.skipStorage) {
      await WIKI.models.storage.pageEvent({
        event: 'deleted',
        page
      })
    }

    // -> Reconnect Links
    await WIKI.models.pages.reconnectLinks({
      locale: page.localeCode,
      path: page.path,
      mode: 'delete'
    })
  }

  /**
   * Reconnect links to new/move/deleted page
   *
   * @param {Object} opts - Page parameters
   * @param {string} opts.path - Page Path
   * @param {string} opts.locale - Page Locale Code
   * @param {string} [opts.sourcePath] - Previous Page Path (move only)
   * @param {string} [opts.sourceLocale] - Previous Page Locale Code (move only)
   * @param {string} opts.mode - Page Update mode (create, move, delete)
   * @returns {Promise} Promise with no value
   */
  static async reconnectLinks (opts) {
    const pageHref = `/${opts.locale}/${opts.path}`
    let replaceArgs = {
      from: '',
      to: ''
    }
    switch (opts.mode) {
      case 'create':
        replaceArgs.from = `<a href="${pageHref}" class="is-internal-link is-invalid-page">`
        replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
        break
      case 'move':
        const prevPageHref = `/${opts.sourceLocale}/${opts.sourcePath}`
        replaceArgs.from = `<a href="${prevPageHref}" class="is-internal-link is-invalid-page">`
        replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
        break
      case 'delete':
        replaceArgs.from = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
        replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-invalid-page">`
        break
      default:
        return false
    }

    let affectedHashes = []
    // -> Perform replace and return affected page hashes (POSTGRES, MSSQL only)
    if (WIKI.config.db.type === 'postgres' || WIKI.config.db.type === 'mssql') {
      affectedHashes = await WIKI.models.pages.query()
        .returning('hash')
        .patch({
          render: WIKI.models.knex.raw('REPLACE(??, ?, ?)', ['render', replaceArgs.from, replaceArgs.to])
        })
        .whereIn('pages.id', function () {
          this.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': opts.path,
            'pageLinks.localeCode': opts.locale
          })
        })
        .pluck('hash')
    } else {
      // -> Perform replace, then query affected page hashes (MYSQL, MARIADB, SQLITE only)
      await WIKI.models.pages.query()
        .patch({
          render: WIKI.models.knex.raw('REPLACE(??, ?, ?)', ['render', replaceArgs.from, replaceArgs.to])
        })
        .whereIn('pages.id', function () {
          this.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': opts.path,
            'pageLinks.localeCode': opts.locale
          })
        })
      affectedHashes = await WIKI.models.pages.query()
        .column('hash')
        .whereIn('pages.id', function () {
          this.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': opts.path,
            'pageLinks.localeCode': opts.locale
          })
        })
        .pluck('hash')
    }
    for (const hash of affectedHashes) {
      await WIKI.models.pages.deletePageFromCache({ hash })
    }
  }

  /**
   * Rebuild page tree for new/updated/deleted page
   *
   * @returns {Promise} Promise with no value
   */
  static async rebuildTree() {
    const rebuildJob = await WIKI.scheduler.registerJob({
      name: 'rebuild-tree',
      immediate: true,
      worker: true
    })
    return rebuildJob.finished
  }

  /**
   * Trigger the rendering of a page
   *
   * @param {Object} page Page Model Instance
   * @returns {Promise} Promise with no value
   */
  static async renderPage(page) {
    const renderJob = await WIKI.scheduler.registerJob({
      name: 'render-page',
      immediate: true,
      worker: true
    }, page.id)
    return renderJob.finished
  }

  /**
   * Fetch an Existing Page from Cache if possible, from DB otherwise and save render to Cache
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async getPage(opts) {
    // -> Get from cache first
    let page = await WIKI.models.pages.getPageFromCache(opts)
    if (!page) {
      // -> Get from DB
      page = await WIKI.models.pages.getPageFromDb(opts)
      if (page) {
        if (page.render) {
          // -> Save render to cache
          await WIKI.models.pages.savePageToCache(page)
        } else {
          // -> No render? Possible duplicate issue
          /* TODO: Detect duplicate and delete */
          throw new Error('Error while fetching page. Duplicate entry detected. Reload the page to try again.')
        }
      }
    }
    return page
  }

  /**
   * Fetch an Existing Page from the Database
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async getPageFromDb(opts) {
    const queryModeID = _.isNumber(opts)
    try {
      return WIKI.models.pages.query()
        .column([
          'pages.id',
          'pages.path',
          'pages.hash',
          'pages.title',
          'pages.description',
          'pages.isPrivate',
          'pages.isPublished',
          'pages.privateNS',
          'pages.publishStartDate',
          'pages.publishEndDate',
          'pages.content',
          'pages.render',
          'pages.toc',
          'pages.contentType',
          'pages.createdAt',
          'pages.updatedAt',
          'pages.editorKey',
          'pages.localeCode',
          'pages.authorId',
          'pages.creatorId',
          {
            authorName: 'author.name',
            authorEmail: 'author.email',
            creatorName: 'creator.name',
            creatorEmail: 'creator.email'
          }
        ])
        .joinRelation('author')
        .joinRelation('creator')
        .eagerAlgorithm(Model.JoinEagerAlgorithm)
        .eager('tags(selectTags)', {
          selectTags: builder => {
            builder.select('tag', 'title')
          }
        })
        .where(queryModeID ? {
          'pages.id': opts
        } : {
          'pages.path': opts.path,
          'pages.localeCode': opts.locale
        })
        // .andWhere(builder => {
        //   if (queryModeID) return
        //   builder.where({
        //     'pages.isPublished': true
        //   }).orWhere({
        //     'pages.isPublished': false,
        //     'pages.authorId': opts.userId
        //   })
        // })
        // .andWhere(builder => {
        //   if (queryModeID) return
        //   if (opts.isPrivate) {
        //     builder.where({ 'pages.isPrivate': true, 'pages.privateNS': opts.privateNS })
        //   } else {
        //     builder.where({ 'pages.isPrivate': false })
        //   }
        // })
        .first()
    } catch (err) {
      WIKI.logger.warn(err)
      throw err
    }
  }

  /**
   * Save a Page Model Instance to Cache
   *
   * @param {Object} page Page Model Instance
   * @returns {Promise} Promise with no value
   */
  static async savePageToCache(page) {
    const cachePath = path.join(process.cwd(), `data/cache/${page.hash}.bin`)
    await fs.outputFile(cachePath, WIKI.models.pages.cacheSchema.encode({
      id: page.id,
      authorId: page.authorId,
      authorName: page.authorName,
      createdAt: page.createdAt,
      creatorId: page.creatorId,
      creatorName: page.creatorName,
      description: page.description,
      isPrivate: page.isPrivate === 1 || page.isPrivate === true,
      isPublished: page.isPublished === 1 || page.isPublished === true,
      publishEndDate: page.publishEndDate,
      publishStartDate: page.publishStartDate,
      render: page.render,
      tags: page.tags.map(t => _.pick(t, ['tag', 'title'])),
      title: page.title,
      toc: _.isString(page.toc) ? page.toc : JSON.stringify(page.toc),
      updatedAt: page.updatedAt
    }))
  }

  /**
   * Fetch an Existing Page from Cache
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async getPageFromCache(opts) {
    const pageHash = pageHelper.generateHash({ path: opts.path, locale: opts.locale, privateNS: opts.isPrivate ? 'TODO' : '' })
    const cachePath = path.join(process.cwd(), `data/cache/${pageHash}.bin`)

    try {
      const pageBuffer = await fs.readFile(cachePath)
      let page = WIKI.models.pages.cacheSchema.decode(pageBuffer)
      return {
        ...page,
        path: opts.path,
        localeCode: opts.locale,
        isPrivate: opts.isPrivate
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return false
      }
      WIKI.logger.error(err)
      throw err
    }
  }

  /**
   * Delete an Existing Page from Cache
   *
   * @param {Object} page Page Model Instance
   * @param {string} page.hash Hash of the Page
   * @returns {Promise} Promise with no value
   */
  static async deletePageFromCache(page) {
    return fs.remove(path.join(process.cwd(), `data/cache/${page.hash}.bin`))
  }

  /**
   * Flush the contents of the Cache
   */
  static async flushCache() {
    return fs.emptyDir(path.join(process.cwd(), `data/cache`))
  }

  /**
   * Migrate all pages from a source locale to the target locale
   *
   * @param {Object} opts Migration properties
   * @param {string} opts.sourceLocale Source Locale Code
   * @param {string} opts.targetLocale Target Locale Code
   * @returns {Promise} Promise with no value
   */
  static async migrateToLocale({ sourceLocale, targetLocale }) {
    return WIKI.models.pages.query()
      .patch({
        localeCode: targetLocale
      })
      .where({
        localeCode: sourceLocale
      })
      .whereNotExists(function() {
        this.select('id').from('pages AS pagesm').where('pagesm.localeCode', targetLocale).andWhereRaw('pagesm.path = pages.path')
      })
  }

  /**
   * Clean raw HTML from content for use in search engines
   *
   * @param {string} rawHTML Raw HTML
   * @returns {string} Cleaned Content Text
   */
  static cleanHTML(rawHTML = '') {
    let data = striptags(rawHTML || '')
      .replace(emojiRegex(), '')
      // .replace(htmlEntitiesRegex, '')
    return he.decode(data)
      .replace(punctuationRegex, ' ')
      .replace(/(\r\n|\n|\r)/gm, ' ')
      .replace(/\s\s+/g, ' ')
      .split(' ').filter(w => w.length > 1).join(' ').toLowerCase()
  }
}
