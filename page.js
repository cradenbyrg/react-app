/**
 * Page abstraction which empowers native <html> component with window.location
 * tracking and navigation routines.
 *
 * 2013 (c) Andrey Popp <8mayday@gmail.com>
 */
"use strict";

var qs = require('querystring'),
    React = require('react-tools/build/modules/React');

function resolve(value) {
  return {
    then: function(func) {
      try {
        var v = func(value);
        return (typeof v.then === 'function') ? v : resolve(v);
      } catch (e) {
        this._error = e
      }
    },
    end: function() {
      if (this._error) throw this._error;
    },
  }
}

/**
 * Shallow equality test
 *
 * Shamelessly stolen from React codebase
 *
 * Copyright 2013 Facebook, Inc.
 */
function shallowEqual(objA, objB) {
  if (objA === objB) {
    return true;
  }
  var key;
  // Test for A's keys different from B.
  for (key in objA) {
    if (objA.hasOwnProperty(key) &&
        (!objB.hasOwnProperty(key) || objA[key] !== objB[key])) {
      return false;
    }
  }
  // Test for B'a keys missing from A.
  for (key in objB) {
    if (objB.hasOwnProperty(key) && !objA.hasOwnProperty(key)) {
      return false;
    }
  }
  return true;
}

module.exports = React.createClass({

  componentDidMount: function() {
    window.addEventListener('popstate', this.onPopState);
  },

  componentWillUnmount: function() {
    window.removeEventListener('popstate', this.onPopState);
  },

  activeContents: function(path, query) {
    var match = this.props.router.match(path);
    if (match) {
      var props = {
        path: path,
        query: query,
        params: match.params
      };
      if (typeof match.handler.getData === 'function') {
        return match.handler.getData(props).then(function(component) {
          component.render().getInitialState().contents;
        });
      } else {
        return match.handler(props).render().getInitialState().contents;
      }
    }
  },

  loadURL: function(path, query) {
    if (path !== this.state.path || !shallowEqual(query, this.state.query)) {
      var contents = this.activeContents(path, query);
      if (contents && typeof contents.then === 'function') {
        contents.then(function(contents) {
          this.setState({
            path: path,
            query: query,
            contents: contents
          });
        }.bind(this)).end()
      } else if (contents) {
        this.setState({
          path: path,
          query: query,
          contents: contents
        });
      }
    }
  },

  navigate: function(path, query) {
    var completeURL = path;
    if (query) {
      completeURL = completeURL + '?' + qs.stringify(query);
    }
    window.history.pushState(null, '', completeURL);
    this.loadURL(path, query);
  },

  onPopState: function(e) {
    e.preventDefault();
    this.loadURL(
      window.location.pathname,
      qs.parse(window.location.search.slice(1)));
  },

  onNavigate: function(e) {
    var href = e.target.attributes.href && e.target.attributes.href.value;
    if (href) {
      e.preventDefault();
      this.navigate(href);
    }
  },

  getInitialState: function() {
    return {
      path: this.props.path,
      query: this.props.query,
      contents: this.props.children
    };
  },

  render: function() {
    return React.DOM.html({onClick: this.onNavigate}, this.state.contents);
  }
});
