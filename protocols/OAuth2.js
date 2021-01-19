/* global Buffer */

/**
 * Module dependencies
 */
const pkg = require('../package.json')
const agent = 'Anvil Connect/' + pkg.version
const qs = require('qs')
const { URL } = require('url')
const util = require('util')
const Strategy = require('passport-strategy')
const request = require('superagent')
const User = require('../models/User')
const AuthorizationError = require('../errors/ProviderAuthError')

/**
 * OAuth2Strategy
 *
 * Provider is an object defining the details of the authentication API.
 * Client is an object containing provider registration info and options.
 * Verify is the Passport callback to invoke after authenticating
 */

function OAuth2Strategy (provider, client, verify) {
  Strategy.call(this)
  this.provider = provider
  this.endpoints = provider.endpoints
  this.mapping = provider.mapping
  this.client = client
  this.name = provider.id
  this.verify = verify
}

util.inherits(OAuth2Strategy, Strategy)

/**
 * Verifier
 */

function verifier (req, auth, userInfo, done) {
  User.connect(req, auth, userInfo, done)
}

OAuth2Strategy.verifier = verifier

/**
 * Initialize
 */

function initialize (provider, configuration) {
  return new OAuth2Strategy(provider, configuration, verifier)
}

OAuth2Strategy.initialize = initialize

/**
 * Authenticate
 */

function authenticate (req, options) {
  const strategy = this
  const error = req.query && req.query.error
  const code = req.query && req.query.code

  options = options || {}

  // Handle authorization endpoint error
  if (error && error === 'access_denied') {
    return strategy.fail('Access denied', 403)
  } else if (error) {
    return strategy.error(new AuthorizationError(req.query))
  }

  // Handle token response
  if (code) {
    // exchange the code for an access token
    strategy.authorizationCodeGrant(code, function (err, response) {
      if (err) { return strategy.error(err) }

      // request user info
      strategy.userInfo(response.access_token, function (err, profile) {
        if (err) { return strategy.error(err) }

        // invoke the callback
        strategy.verify(req, response, profile, function (err, user, info) {
          if (err) { return strategy.error(err) }
          if (!user) { return strategy.fail(info) }
          strategy.success(user, info)
        })
      })
    })

    // Initiate the OAuth 2.0 Authorization Code Flow
  } else {
    strategy.authorizationRequest(req, options)
  }
}

OAuth2Strategy.prototype.authenticate = authenticate

/**
 * Base64 Credentials
 *
 * Base64 encodes the user:password value for an HTTP Basic Authorization
 * header from a provider configuration object. The provider object should
 * specify a clientId and client_secret.
 */

function base64credentials () {
  const id = this.client.client_id
  const secret = this.client.client_secret
  const credentials = id + ':' + secret

  return Buffer.from(credentials).toString('base64')
}

OAuth2Strategy.prototype.base64credentials = base64credentials

/**
 * Authorization Request
 */

function authorizationRequest (req, options) {
  const provider = this.provider
  const endpoints = this.endpoints
  const config = this.client
  const url = new URL(endpoints.authorize.url)
  const responseType = 'code'
  const clientId = config.client_id
  const redirectUri = provider.redirect_uri
  const state = options.state
  const prompt = req.query.prompt

  // required authorization parameters
  url.searchParams.set('response_type', responseType)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)

  // merge default and configured scopes
  if (provider.scope || config.scope) {
    const s1 = provider.scope || []
    const s2 = config.scope || []
    const sp = provider.separator || ' '

    url.searchParams.set('scope', s1.concat(s2).join(sp))
  }

  if (state) {
    url.searchParams.set('state', state)
  }

  if (prompt) {
    url.searchParams.set('prompt', prompt)
  }

  // Redirect to the provider. This method is
  // added at runtime by passport and not explicitly
  // defined here.
  this.redirect(url.toString())
}

OAuth2Strategy.prototype.authorizationRequest = authorizationRequest

/**
 * Authorization Code Grant Request
 */

function authorizationCodeGrant (code, done) {
  const endpoint = this.endpoints.token
  const provider = this.provider
  const client = this.client
  const url = endpoint.url
  const method = endpoint.method && endpoint.method.toLowerCase()
  const auth = endpoint.auth
  const parser = endpoint.parser
  const accept = endpoint.accept || 'application/json'
  const params = {}

  // required token parameters
  params.grant_type = 'authorization_code'
  params.code = code
  params.redirect_uri = provider.redirect_uri

  // start building the request
  const req = request[method || 'post'](url)

  // Authenticate the client with HTTP Basic
  if (auth === 'client_secret_basic') {
    req.set('Authorization', 'Basic ' + this.base64credentials())
  }

  // Authenticate the client with POST params
  if (auth === 'client_secret_post') {
    params.client_id = client.client_id
    params.client_secret = client.client_secret
  }

  // Add request body params and set other headers
  req.send(qs.stringify(params))
  req.set('accept', accept)
  req.set('user-agent', agent)

  // Execute the request
  return req.end(function (err, res) {
    if (err) { return done(err) }
    const response = (parser === 'x-www-form-urlencoded')
      ? qs.parse(res.text)
      : res.body

    if (res.statusCode !== 200) {
      return done(response)
    }

    done(null, response)
  })
}

OAuth2Strategy.prototype.authorizationCodeGrant = authorizationCodeGrant

/**
 * User Info
 */

function userInfo (token, done) {
  const strategy = this
  const endpoint = this.endpoints.user
  const mapping = this.mapping
  const url = endpoint.url
  const method = endpoint.method && endpoint.method.toLowerCase()
  const auth = endpoint.auth
  const params = endpoint.params
  const accept = endpoint.accept || 'application/json'

  // start building the request
  const req = request[method || 'get'](url)

  // Authenticate with custom header
  if (auth && auth.header) {
    req.set(auth.header, (auth.scheme === 'Basic')
      ? strategy.base64credentials()
      : [auth.scheme, token].join(' ')
    )
  }

  // Authenticate with a querystring parameter
  if (auth && auth.query) {
    req.query(auth.query + '=' + token)
  }

  // Additional parameters
  if (params) {
    req.query(params)
  }

  // Set other headers
  req.set('accept', accept)
  req.set('user-agent', agent)

  // Execute the request
  return req.end(function (err, res) {
    // Handle unsuccessful response
    if (err || res.statusCode !== 200) {
      return done(
        (res && new Error(res.body && res.body.error)) || err
      )
    }

    // add the strategy name to response
    res.body.provider = strategy.name

    // TODO:
    // - should we fail if we can't derive a provider user id?

    // Normalize id field
    res.body.id = (res.body.id)
      ? res.body.id.toString()
      : res.body[mapping.id] && res.body[mapping.id].toString()

    // Provide the user
    done(null, res.body)
  })
}

OAuth2Strategy.prototype.userInfo = userInfo

/**
 * Exports
 */

module.exports = OAuth2Strategy
