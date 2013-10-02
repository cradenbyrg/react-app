/**
 * Express application for serving rendered React components and corresponding
 * client code.
 *
 * 2013 (c) Andrey Popp <8mayday@gmail.com>
 */
"use strict";

var path                = require('path'),
    domain              = require('domain'),
    url                 = require('url'),
    express             = require('express'),
    q                   = require('kew'),
    callsite            = require('callsite'),
    DCompose            = require('dcompose'),
    reactify            = require('reactify'),
    aggregate           = require('stream-aggregate-promise'),
    utils               = require('lodash'),
    makeXMLHttpRequest  = require('./xmlhttprequest'),
    Router              = require('./router');

function _genServerRenderingCode(module, props) {
  return [
    "var ExecutionEnvironment = require('react-tools/build/modules/ExecutionEnvironment');",
    "ExecutionEnvironment.canUseDOM = false;",
    "var React = require('react-tools/build/modules/React');",
    "var bootstrapComponent = require('react-app/bootstrap').bootstrapComponent;",
    "var Component = require(" + JSON.stringify(module) + ");",
    "var props = " + JSON.stringify(props) + ";",
    "var cloneDeep = require('lodash.clonedeep');",
    "bootstrapComponent(Component, props, function(err, spec) {",
    "  if (err) return __react_app_callback(err);",
    "  React.renderComponentToString(",
    "    spec.Component(cloneDeep(spec.props)),",
    "    function(markup) {",
    "    __react_app_callback(null, {markup: markup, props: spec.props});",
    "  });",
    "});",
  ].join('\n');
}

function _genClientRoutingCode(handler, props, routes) {
  return [
    "<script>",
    "  var __bootstrap = function() {",
    "    var handler = require(" + JSON.stringify(handler) + ");",
    "    var props = " + JSON.stringify(props) + ";",
    "    var routes = " + JSON.stringify(routes) + ";",
    "    var bootstrap = require('react-app/bootstrap');",
    "    for (var key in routes) {",
    "      routes[key] = require(routes[key]);",
    "    }",
    "    bootstrap(handler, props, routes);",
    "  };",
    "</script>"
  ].join('\n');
}

/**
 * Render React component into string.
 *
 * @param {String} bundle Computed browserify bundle which serves as environment
 * @param {String} module Module name which points to React component to render
 * @param {Object} props Component props to use
 * @param {Object} location
 * @returns {String} Rendered React component
 */
function renderComponent(bundle, module, props, location) {
  var dom = domain.create(),
      promise = q.defer(),
      XMLHttpRequest = makeXMLHttpRequest(location),
      context = {
        __react_app_callback: promise.makeNodeResolver(),
        console: console,
        XMLHttpRequest: XMLHttpRequest,
        location: location,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval
      },
      contextify = require('contextify');

  context.self = context;
  context.window = context;

  dom.on('error', promise.reject.bind(promise));
  dom.run(function() {
    contextify(context);
    context.run(bundle);
    context.run(_genServerRenderingCode(module, props));
  });

  return promise.then(function(result) {
    // if we dispose context on the current tick we will crash cause Node didn't
    // free some I/O handles yet
    process.nextTick(function() { context.dispose(); });
    return result;
  });
}

/**
 * Insert <script> tag into markup.
 *
 * @param {String} markup Markup to insert script tag into
 * @param {String} tag Script tag to insert
 * @returns {String} Markup with inserted script tags
 */
function _insertIntoHead(markup, tag) {
  var index = markup.indexOf('</head>');
  if (index > -1) {
    return markup.slice(0, index) + tag + markup.slice(index);
  } else {
    return markup + tag;
  }
}

/**
 * Send a page a currently active React component as HTML.
 *
 * @param {routes} routes Route table
 * @param {function} getBundle Returns a promise for a computed bundle
 * @param {Object} pageOptions
 */
function sendPage(routes, bundle, pageOptions, origin) {
  return function(req, res, next) {
    var router = new Router(routes),
        match = router.match(req.path);

    if (!match) {
      return next();
    }

    var props = {
      path: req.path,
      query: req.query,
      params: match.params,
      options: pageOptions
    };

    var reqOrigin = origin || (
          (!!req.connection.verifyPeer ? 'https://' : 'http://') +
          req.headers.host);
    var location = url.parse(reqOrigin + req.originalUrl);

    bundle.js
      .then(function(result) {
        return renderComponent(result, match.handler, props, location);
      }).then(function(rendered) {
        rendered = _insertIntoHead(rendered.markup,
          _genClientRoutingCode(match.handler, rendered.props, routes) +
          '<link rel="stylesheet" href="/assets/app.css">' +
          '<script async onload="__bootstrap();" src="/assets/app.js"></script>')
        return res.send(rendered);
      }).fail(next);
  };
}

/**
 * Send computed script bundle.
 *
 * @param {function} bundle returns a promise for a computed bundle
 */
function sendScript(bundle) {
  return function(req, res, next) {
    res.setHeader('Content-Type', 'application/json');
    bundle.js.then(function(bundle) { res.send(bundle) }).fail(next);
  };
}

function sendStyles(bundle) {
  return function(req, res, next) {
    res.setHeader('Content-Type', 'text/css');
    bundle.css.then(function(bundle) { res.send(bundle) }).fail(next);
  };
}

/**
 * Construct express application which serves rendered React components as HTML
 * and corresponding client code.
 *
 * Route table should be in form of {route pattern: node module id}.
 *
 * Available option keys are:
 *
 *  - `configureBundle` configures browserify bundle
 *  - `debug` inserts source maps into bundle and starts watching for source
 *    code changes
 *
 * @param {Object} routes Route table
 * @param {Object} opts Options
 * @retuens {Object} Configured express application
 */
module.exports = function(routes, opts) {
  opts = opts || {};

  var root = opts.root || path.dirname(callsite()[1].getFileName()),
      app = express(),
      bundle = {};

  function log() {
    if (opts.debug) console.log.apply(console, arguments)
  }

  function buildBundle(detected) {
    var streams = composer.all({debug: opts.debug});
    for (var k in streams)
      bundle[k] = aggregate(streams[k]);
    if (opts.debug) {
      var start = Date.now();
      q.all(utils.values(bundle)).then(function() {
        log('bundle built in', Date.now() - start, 'ms');
      });
    }
  }

  var pages = []
  for (var k in routes) {
    pages.push({
      id: routes[k][0] === '.' ?  path.resolve(root, routes[k]) : routes[k],
      expose: routes[k],
      entry: false
    });
  }

  var composer = new DCompose({
    entries: [
      {id: require.resolve('lodash.clonedeep'), expose: 'lodash.clonedeep', entry: false},
      {id: 'react-tools/build/modules/React', expose: true, entry: false},
      {id: 'react-tools/build/modules/ExecutionEnvironment', expose: true, entry: false},
      {id: path.join(__dirname, './bootstrap'), expose: 'react-app/bootstrap', entry: false},
    ].concat(pages),
    transform: [].concat(opts.transforms, reactify),
    watch: opts.debug
  });


  composer.on('update', buildBundle);

  buildBundle();

  app.get('/assets/app.js', sendScript(bundle));
  app.get('/assets/app.css', sendStyles(bundle));
  app.use(sendPage(routes, bundle, opts.pageOptions, opts.origin));

  return app;

};
