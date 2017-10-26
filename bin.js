#!/usr/bin/env node

const globby = require('globby')
const got = require('got')
const neodoc = require('neodoc')
const ora = require('ora')
const path = require('path')
const proxyquire = require('proxyquire')
const revHash = require('rev-hash')
const CloudFront = require('aws-sdk/clients/cloudfront')
const S3 = require('aws-sdk/clients/s3')

const express = require(path.join(process.cwd(), 'node_modules', 'express'))

const usage = `
Niobium

Usage:
  niobium --s3-bucket=<bucket> --cloudfront-distribution-id=<distribution-id>

Options:
  --s3-bucket                    Name of the S3 bucket in which to put the files.
  --cloudfront-distribution-id   ID of the cloudfront distribution where the files are served.
`

const s3 = new S3({ apiVersion: '2006-03-01' })
const cloudfront = new CloudFront({ apiVersion: '2017-03-25' })

async function expandRoutes ({ dynamicRoutes, staticRoutes }) {
  let routes = [...dynamicRoutes]

  for (const [mount, root] of staticRoutes) {
    routes = [...routes, ...globby.sync('**/*', { cwd: root }).map(p => `${mount.replace(/\/$/, '')}/${p}`)]
  }

  return routes
}

function loadApp () {
  return new Promise((resolve) => {
    const kStatic = Symbol('static')

    let dynamicRoutes = []
    let staticRoutes = []

    const createProxiedInstance = (target) => {
      return new Proxy(target, {
        get (target, property) {
          function get (path, ...args) {
            if (args.length > 0) {
              dynamicRoutes.push(path)
            }

            return target.get(path, ...args)
          }

          function listen () {
            expandRoutes({ dynamicRoutes, staticRoutes }).then(routes => resolve({ app: target, routes }))
          }

          function use (...args) {
            if (typeof args[0] === 'string' && args[1][kStatic]) {
              staticRoutes.push([args[0], args[1][kStatic]])
            }

            if (args[0][kStatic]) {
              staticRoutes.push(['/', args[0][kStatic]])
            }

            return target.use(...args)
          }

          if (property === 'get') return get
          if (property === 'listen') return listen
          if (property === 'use') return use

          return target[property]
        }
      })
    }

    const proxiedExpress = new Proxy(express, {
      apply (target, thisArg, argumentsList) {
        return createProxiedInstance(target.apply(thisArg, argumentsList))
      },

      construct (Target, argumentsList) {
        return createProxiedInstance(new Target(...argumentsList))
      },

      get (target, property) {
        function staticFn (root, ...args) {
          return Object.assign(target.static(root, ...args), { [kStatic]: path.resolve(root) })
        }

        if (property === 'static') return staticFn

        return target[property]
      }
    })

    proxyquire(process.cwd(), { express: proxiedExpress })
  })
}

function startServer (app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      function closeServer () {
        return new Promise((resolve) => server.close(resolve))
      }

      const port = server.address().port
      const address = `http://localhost:${port}`

      resolve({ address, closeServer })
    })
  })
}

async function getCurrentHash (file) {
  const params = {
    Bucket: file['Bucket'],
    Key: file['Key']
  }

  let response
  try {
    response = await s3.headObject(params).promise()
  } catch (err) {
    if (err.code === 'NotFound') return null

    throw err
  }

  return (response.Metadata['niobiumhash'] || null)
}

async function invalidateRotues (distributionId, routes) {
  const params = {
    DistributionId: distributionId,
    InvalidationBatch: {
      CallerReference: String(Date.now()),
      Paths: {
        Quantity: routes.length,
        Items: routes
      }
    }
  }

  await cloudfront.createInvalidation(params).promise()
}

async function main () {
  const args = neodoc.run(usage)
  const spinner = ora()

  try {
    spinner.start('Loading express app')
    const { app, routes } = await loadApp()
    const { address, closeServer } = await startServer(app)
    spinner.succeed()

    try {
      const allFiles = new Map()

      spinner.start(`Fetching routes (${allFiles.size}/${routes.length}`)
      for (const route of routes) {
        const res = await got(`${address}${route}`, { encoding: null, followRedirect: false })
        const file = {}

        file['ACL'] = 'public-read'
        file['Body'] = res.body
        file['Bucket'] = args['--s3-bucket']

        if (res.headers['cache-control']) {
          file['CacheControl'] = res.headers['cache-control']
        }

        if (res.headers['content-type']) {
          file['ContentType'] = res.headers['content-type']
        }

        file['Key'] = (route === '/' ? 'index.html' : route.replace(/^\//, ''))

        file['Metadata'] = {
          'niobiumhash': revHash(`v1-${file['CacheControl']}-${file['ContentType']}-${revHash(res.body)}`)
        }

        allFiles.set(route, file)
        spinner.text = `Fetching routes (${allFiles.size}/${routes.length}`
      }
      spinner.succeed(`Fetching routes (${allFiles.size})`)

      const changedFiles = new Map()

      spinner.start(`Finding changed files (${changedFiles.size})`)
      for (const [route, file] of allFiles) {
        const currentHash = await getCurrentHash(file)

        if (currentHash !== file['Metadata']['niobiumhash']) {
          changedFiles.set(route, file)
          spinner.text = `Finding changed files (${changedFiles.size})`
        }
      }
      spinner.succeed(`Finding changed files (${changedFiles.size})`)

      if (changedFiles.size) {
        let uploadedFiles = 0
        spinner.start(`Uploading changed files (${uploadedFiles}/${changedFiles.size})`)
        for (const [, file] of changedFiles) {
          await s3.upload(file).promise()
          spinner.text = `Uploading changed files (${++uploadedFiles}/${changedFiles.size})`
        }
        spinner.succeed(`Uploading changed files (${uploadedFiles}/${changedFiles.size})`)

        spinner.start('Invalidating CloudFront cache')
        await invalidateRotues(args['--cloudfront-distribution-id'], [...changedFiles.keys()])
        spinner.succeed()
      }
    } finally {
      await closeServer()
    }
  } catch (err) {
    spinner.fail(err.toString())
    throw err
  }
}

main().catch((err) => {
  process.exitCode = 1
  console.error(err.stack)
})
