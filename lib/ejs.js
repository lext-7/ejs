/*
 * EJS Embedded JavaScript templates
 * Copyright 2112 Matthew Eernisse (mde@fleegix.org)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

'use strict';

/**
 * @file Embedded JavaScript templating engine.
 * @author Matthew Eernisse <mde@fleegix.org>
 * @author Tiancheng "Timothy" Gu <timothygu99@gmail.com>
 * @project EJS
 * @license {@link http://www.apache.org/licenses/LICENSE-2.0 Apache License, Version 2.0}
 */

/**
 * EJS internal functions.
 *
 * Technically this "module" lies in the same file as {@link module:ejs}, for
 * the sake of organization all the private functions re grouped into this
 * module.
 *
 * @module ejs-internal
 * @private
 */

/**
 * Embedded JavaScript templating engine.
 *
 * @module ejs
 * @public
 */

var fs = require('fs');
var path = require('path');
var utils = require('./utils');

var scopeOptionWarned = false;
var _VERSION_STRING = require('../package.json').version;
var _DEFAULT_DELIMITER = '%';
var _DEFAULT_LOCALS_NAME = 'locals';
var _COMPILE_DEBUG_REGEXP = '\\\\n';
var _REGEX_STRING = '(([(\\\\r)(\\\\\\\\n)\\s]*)(<%(?!%)[=\\-_#]?)\\s*(.*?)\\s*([\\-_]?%>)([(\\\\r)(\\\\\\\\n)\\s]*))';
var _LITERAL_REGEX_STRING = '<%%|%%>';
var _OPTS = [
  'cache', 'filename', 'delimiter', 'scope', 'context',
  'debug', 'compileDebug', 'client', '_with', 'root', 'rmWhitespace',
  'strict', 'localsName', 'usePages', 'pages'
];
var _BOM = /^\uFEFF/;
var _INCLUDE_DIRECTIVE_REGEXP = /^\s*include\s+(\S+)/;
var _INCLUDE_FUNC_REGEXP = /^\s*include\s*\("(.+?)"/;

/**
 * EJS template function cache. This can be a LRU object from lru-cache NPM
 * module. By default, it is {@link module:utils.cache}, a simple in-process
 * cache that grows continuously.
 *
 * @type {Cache}
 */

exports.cache = utils.cache;

/**
 * Name of the object containing the locals.
 *
 * This variable is overridden by {@link Options}`.localsName` if it is not
 * `undefined`.
 *
 * @type {String}
 * @public
 */

exports.localsName = _DEFAULT_LOCALS_NAME;

/**
 * Get the path to the included file from the parent file path and the
 * specified path.
 *
 * @param {String}  name     specified path
 * @param {String}  filename parent file path
 * @param {Boolean} isDir    parent file path whether is directory
 * @return {String}
 */
exports.resolveInclude = function (name, filename, isDir) {
  var dirname = path.dirname;
  var extname = path.extname;
  var resolve = path.resolve;
  var includePath = resolve(isDir ? filename : dirname(filename), name);
  var ext = extname(name);
  if (!ext) {
    includePath += '.ejs';
  }
  return includePath;
};

/**
 * Get the path to the included file by Options
 *
 * @param  {String}  path    specified path
 * @param  {Options} options compilation options
 * @return {String}
 */
function getIncludePath(path, filename, root) {
  var includePath;
  if (path.charAt(0) == '/') {
    includePath = exports.resolveInclude(path.replace(/^\/*/, ''), root || '/', true);
  } else {
    if (!filename) {
      throw new Error("`include` use relative path requires the 'filename' option.");
    }
    includePath = exports.resolveInclude(path, filename);
  }
  return includePath;
}

/**
 * Re-throw the given `err` in context to the `str` of ejs, `filename`, and
 * `lineno`.
 *
 * @implements RethrowCallback
 * @memberof module:ejs-internal
 * @param {Error}  err      Error object
 * @param {String} str      EJS source
 * @param {String} filename file name of the EJS file
 * @param {String} lineno   line number of the error
 * @static
 */

function rethrow(err, str, filename, lineno) {
  var lines = str.split('\n');
  var start = Math.max(lineno - 3, 0);
  var end = Math.min(lines.length, lineno + 3);
  // Error context
  var context = lines.slice(start, end).map(function (line, i) {
    var curr = i + start + 1;
    return (curr == lineno ? ' >> ' : '    ') +
      curr +
      '| ' +
      line;
  }).join('\n');

  // Alter exception message
  err.path = filename;
  err.message = (filename || 'ejs') + ':' +
    lineno + '\n' +
    context + '\n\n' +
    err.message;

  throw err;
}

/**
 * Copy properties in data object that are recognized as options to an
 * options object.
 *
 * This is used for compatibility with earlier versions of EJS and Express.js.
 *
 * @memberof module:ejs-internal
 * @param {Object}  data data object
 * @param {Options} opts options object
 * @static
 */

function cpOptsInData(data, opts) {
  _OPTS.forEach(function (p) {
    if (typeof data[p] != 'undefined') {
      opts[p] = data[p];
    }
  });
}

/**
 * Read file and handle BOM problem.
 *
 * @param {String}  filename file path to read.
 *
 * @return {String}
 * File content.
 */

function readFile(filename) {
  return fs.readFileSync(filename).toString().replace(_BOM, '');
}

/**
 * Compile the given `str` of ejs into a template function.
 *
 * @param {String}  template EJS template
 *
 * @param {Options} opts     compilation options
 *
 * @return {(TemplateFunction|ClientFunction)}
 * Depending on the value of `opts.client`, either type might be returned.
 * @public
 */

exports.compile = function compile(template, opts) {
  var fn;

  // v1 compat
  // 'scope' is 'context'
  // FIXME: Remove this in a future version
  if (opts && opts.scope) {
    if (!scopeOptionWarned) {
      console.warn('`scope` option is deprecated and will be removed in EJS 3');
      scopeOptionWarned = true;
    }
    if (!opts.context) {
      opts.context = opts.scope;
    }
    delete opts.scope;
  }
  if (opts && !opts.usePages && opts.cache && opts.filename) {
    fn = exports.cache.get(opts.filename);
    if (fn) {
      return fn;
    }
  }
  if (typeof template === 'undefined' || template === null) {
    template = readFile(opts.filename);
  }
  fn = new Template(template, opts).compile();
  if (opts && opts.cache) {
    exports.cache.set(opts.filename, fn);
  }
  return fn;
};

/**
 * Render the given `template` of ejs.
 *
 * If you would like to include options but not data, you need to explicitly
 * call this function with `data` being an empty object or `null`.
 *
 * @param {String}   template EJS template
 * @param {Object}  [data={}] template data
 * @param {Options} [opts={}] compilation and rendering options
 * @return {String}
 * @public
 */

exports.render = function (template, d, o) {
  var data = d || {};
  var opts = o || {};

  // No options object -- if there are optiony names
  // in the data, copy them to options
  if (arguments.length == 2) {
    cpOptsInData(data, opts);
  }
  return exports.compile(template, opts)(data);
};

/**
 * Render an EJS file at the given `path` and callback `cb(err, str)`.
 *
 * If you would like to include options but not data, you need to explicitly
 * call this function with `data` being an empty object or `null`.
 *
 * @param {String}             path     path to the EJS file
 * @param {Object}            [data={}] template data
 * @param {Options}           [opts={}] compilation and rendering options
 * @param {RenderFileCallback} cb callback
 * @public
 */

exports.renderFile = function () {
  var args = Array.prototype.slice.call(arguments);
  var filename = args.shift();
  var cb = args.pop();
  var data = args.shift() || {};
  var opts = args.pop() || {};
  var result;

  // Don't pollute passed in opts obj with new vals
  opts = utils.shallowCopy({}, opts);

  // No options object -- if there are optiony names
  // in the data, copy them to options
  if (arguments.length == 3) {
    // Express 4
    if (data.settings && data.settings['view options']) {
      cpOptsInData(data.settings['view options'], opts);
    }
    // Express 3 and lower
    else {
      cpOptsInData(data, opts);
    }
  }
  opts.filename = filename;

  try {
    result = exports.compile(null, opts)(data);
  } catch (err) {
    return cb(err);
  }
  return cb(null, result);
};

/**
 * Clear intermediate JavaScript cache. Calls {@link Cache#reset}.
 * @public
 */

exports.clearCache = function () {
  exports.cache.reset();
};

function Template(text, opts) {
  opts = opts || {};
  var options = {};
  this.templateText = text;
  this.source = '';
  this.dependencies = {};
  this.pathStack = [opts.filename];
  options.client = opts.client || false;
  options.usePages = opts.usePages;
  if (options.usePages) {
    options.pages = opts.pages;
  }
  options.precompile = opts.precompile;
  options.loadOnlyOnce = opts.loadOnlyOnce;
  options.escapeFunction = opts.escape || utils.escapeXML;
  options.compileDebug = opts.compileDebug !== false;
  options.debug = !!opts.debug;
  options.filename = opts.filename;
  options.delimiter = opts.delimiter || exports.delimiter || _DEFAULT_DELIMITER;
  options.strict = opts.strict || false;
  options.context = opts.context;
  options.cache = opts.cache || false;
  options.rmWhitespace = opts.rmWhitespace;
  options.root = opts.root;
  options.localsName = opts.localsName || exports.localsName || _DEFAULT_LOCALS_NAME;

  if (options.strict) {
    options._with = false;
  } else {
    options._with = typeof opts._with != 'undefined' ? opts._with : true;
  }
  this.opts = options;
}

Template.prototype = {
  createRegex: function () {
    var str = this.opts.compileDebug ? _REGEX_STRING + '|' + _COMPILE_DEBUG_REGEXP : _REGEX_STRING;
    var delim = utils.escapeRegExpChars(this.opts.delimiter);
    str = str.replace(/%/g, delim);
    return {
      replace: new RegExp(str, 'g'),
      literal: new RegExp(_LITERAL_REGEX_STRING.replace(/%/g, delim), 'g')
    };
  },

  compile: function () {
    var compiledOpts = this.compiledOpts = this.parseOptions();
    var opts = this.opts;
    var renderFn;

    this.source = compiledOpts.globalPrepened + this.generateSource(this.templateText, opts.filename) + compiledOpts.globalAppended;

    if (opts.precompile) {
      for (var i = 0; i < opts.precompile.length; i++) {
        this.includeFile(opts.precompile[i]);
      }
    }

    if (opts.client) {
      var __dependencies = {};
      for (var dep in this.dependencies) {
        if (this.dependencies.hasOwnProperty(dep)) {
          __dependencies[dep] = this.dependencies[dep].toString();
        }
      }
      this.source = 'var __dependencies = ' + JSON.stringify(__dependencies) + ';\n' + this.source;
    }

    if (opts.debug) {
      console.log(this.source);
    }

    try {
      renderFn = this.sourceToFunc(this.source);
    } catch (e) {
      // istanbul ignore else
      if (e instanceof SyntaxError) {
        if (opts.filename) {
          e.message += ' in ' + opts.filename;
        }
        e.message += ' while compiling ejs\n\n';
        e.message += 'If the above error is not helpful, you may want to try EJS-Lint:\n';
        e.message += 'https://github.com/RyanZim/EJS-Lint';
      }
      throw e;
    }

    if (opts.client) {
      return renderFn;
    }

    // Return a callable function which will execute the function
    // created by the source-code, with the passed data as locals
    // Adds a local `include` function which allows full recursive include
    var returnedFn = (function (context, escape, rethrow, utils, renderFn) {
      return function (data) {
        var include = function (path, includeData) {
          var d = utils.shallowCopy({}, data);
          if (includeData) {
            d = utils.shallowCopy(d, includeData);
          }
          var compiled = context.includeFile(path)(d, escape, include, rethrow);
          context.pathStack.pop();
          return compiled;
        };
        return renderFn.apply(opts.context, [data || {}, escape, include, rethrow]);
      };
    })(this, opts.escapeFunction, rethrow, utils, renderFn);
    return returnedFn;
  },

  parseOptions: function () {
    var opts = this.opts;
    var escape = opts.escapeFunction;
    var delimiter = {
      escaped: '<' + opts.delimiter + '=',
      raw: '<' + opts.delimiter + '-',
      literalStart: '<' + opts.delimiter + opts.delimiter,
      literalEnd: opts.delimiter + opts.delimiter + '>',
      whitespaceSlurpingStart: '<' + opts.delimiter + '_',
      whitespaceSlurpingEnd: '_' + opts.delimiter + '>',
      comment: '<' + opts.delimiter + '#',
      scriptlet: '<' + opts.delimiter,
      plainEnd: opts.delimiter + '>',
      rmNewLine: '-' + opts.delimiter + '>'
    };
    var compileDebug = opts.compileDebug;
    var prepended = 'var __filename = __filename__;';
    var globalPrepened = '';
    var appended = '';
    var globalAppended = '';

    if (opts.strict) {
      globalPrepened = '"use strict";\n';
    }

    if (opts.client) {
      globalPrepened = 'escape = escape || ' + escape.toString() + ';\n' +
        'var __shallowCopy = ' + utils.shallowCopy.toString() + ';\n' +
        'var include = ' + this.clientIncludeString.replace(/__locals__/, opts.localsName) + ';\n' +
        'var __root = ' + JSON.stringify(opts.root) + ';\n' + globalPrepened;
      if (compileDebug) {
        globalPrepened = 'rethrow = rethrow || ' + rethrow.toString() + ';\n' + globalPrepened;
      }
    }

    if (compileDebug) {
      prepended += 'var __line = 1, __lines = __template__;\ntry { \n';
      appended += '; return __output;\n} catch (e) {\nrethrow(e, __lines, __filename, __line);\n}';
    }

    if (opts._with !== false) {
      prepended += 'with(' + opts.localsName + ' || {}) {\n';
      appended = '}\n' + appended;
    }

    prepended += "var __output = '";

    var regex = this.createRegex();
    return {
      escape: opts.escapeFunction,
      prepended: prepended,
      globalPrepened: globalPrepened,
      appended: appended,
      globalAppended: globalAppended,
      delimiter: delimiter,
      regex: regex.replace,
      literalRegex: regex.literal,
      includeDirectiveRegexp: _INCLUDE_DIRECTIVE_REGEXP,
      includeFuncRegexp: _INCLUDE_FUNC_REGEXP,
    };
  },

  generateSource: function (template, filename) {
    var self = this;
    var opts = this.opts;
    var compiledOpts = this.compiledOpts;
    var delimiter = compiledOpts.delimiter;
    var line = 1;
    var compileDebug = opts.compileDebug;
    var includeDirectiveRegexp = compiledOpts.includeDirectiveRegexp;
    var includeFuncRegexp = compiledOpts.includeFuncRegexp;
    var prepended = compiledOpts.prepended;

    prepended = prepended.replace(/__filename__/, JSON.stringify(filename));
    if (compileDebug) {
      prepended = prepended.replace(/__template__/, JSON.stringify(template));
    }

    if (opts.rmWhitespace) {
      template = template.replace(/\r/g, '').replace(/^\s+|\s+$/gm, '');
    }

    template = template
      .replace(/'|\\/g, '\\$&')
      .replace(/\n/g, '\\n');

    if (!opts.rmWhitespace) {
      template = template.replace(/\r/g, '\\r');
    }

    return prepended + template
      .replace(compiledOpts.regex, function (match, notUsed, before, prefix, content, suffix, after) {
        var unhandledLine;
        var included = false;
        if (compileDebug) {
          if (match === '\\n') {
            line++;
            return match;
          }
          var baforeLines = before.match(/\\n/g);
          var afterLines = after.match(/\\n/g);
          var contentLines = content.match(/\\n/g);
          if (baforeLines) {
            line += baforeLines.length;
          }
          unhandledLine = line;
          if (contentLines) {
            line += contentLines.length;
          }
          if (afterLines) {
            line += afterLines.length;
          }
        }

        if (prefix === delimiter.whitespaceSlurpingStart) {
          before = before.replace(/[\s\t]*$/, '');
        }
        if (suffix === delimiter.whitespaceSlurpingEnd || opts.rmWhitespace) {
          after = after.replace(/^[\s\t]*(\\n)?/, '');
        } else if (suffix === delimiter.rmNewLine) {
          after = after.replace(/(\\r)?\\n/, '');
        }

        if (prefix === delimiter.comment) {
          return '';
        }

        content = content.replace(/\\n/g, '\n').replace(/\\'/g, "'");

        if (prefix !== delimiter.comment) {
          var includeMatch = content.match(includeDirectiveRegexp);
          var includeFilename;
          var includeSource;
          if (includeMatch) {
            includeFilename = includeMatch[1];
            includeSource = self.includeSource(includeFilename, filename);
            includeSource = '(function () {' + includeSource + '}).call(this)';
            content = includeSource;
            included = true;
          } else if (opts.client) {
            includeMatch = content.match(includeFuncRegexp);
            if (includeMatch) {
              includeFilename = includeMatch[1];
              self.includeFile(includeFilename);
            }
          }
          if (/^\s*(undefined)|(null)\s*/.test(content)) {
            content = "''";
          }
        }

        switch (prefix) {
        case delimiter.escaped:
          return before + "' + " + 'escape(' + content + (compileDebug ? ', __line = ' + unhandledLine : '') + ") + '" + after;
        case delimiter.raw:
          content = content.replace(/;\s*$/, '');
          return before + "' + (" + (compileDebug ? '__line = ' + unhandledLine + ', ' : '') + content + ") + '" + after;
        case delimiter.scriptlet:
        case delimiter.whitespaceSlurpingStart:
          if (included) {
            content = ';__output += ' + content;
          }
          return before + '\';\n' + (compileDebug ? '__line = ' + unhandledLine + ';' : '') + content + ';\n' + '__output += \'' + after;
        case delimiter.comment:
          return before + "'/*" + content + "*/ + '" + after;
        default:
          return before + content + after;
        }
      }).replace(compiledOpts.literalRegex, function (match) {
        return match[0] === '<' ? match.substr(0, match.length - 1) : match.substr(1);
      }) + "'" + compiledOpts.appended;
  },

  sourceToFunc: function (source) {
    return new Function(this.opts.localsName + ', escape, include, rethrow', source);
  },

  includeFile: function (path) {
    var opts = this.opts;
    var pathStack = this.pathStack;
    var parentFilename = pathStack[pathStack.length - 1];
    var filename = opts.usePages ? path : getIncludePath(path, parentFilename, opts.root);
    var clientFilename = opts.client ? path[0] === '/' ? opts.root + path : parentFilename.substr(0, parentFilename.lastIndexOf('/') + 1) + path : null;
    var depFunc = this.dependencies[opts.client ? clientFilename : filename];
    var func = depFunc;
    var cached = false;

    pathStack.push(filename);

    if (!func && opts.cache && !opts.client) {
      func = exports.cache.get(filename);
      cached = !!func;
    }
    if (!func) {
      var template = opts.usePages ? opts.pages[path] : readFile(filename);
      var source = this.generateSource(template, filename);
      func = this.sourceToFunc(source);
    }
    if (!depFunc && (opts.loadOnlyOnce || opts.client)) {
      this.dependencies[opts.client ? clientFilename : filename] = func;
    }
    if (!cached && opts.cache && !opts.client) {
      exports.cache.set(filename, func);
    }
    return func;
  },

  includeSource: function (path) {
    var source = this.includeFile(path).toString();
    source = source.substr(source.indexOf('{'), source.lastIndexOf('}'));
    this.pathStack.pop();
    return source;
  },

  clientIncludeString: function (path, includeData) {
    /*eslint-disable */
    path = path[0] === '/' ? __root + path : __filename.substr(0, __filename.lastIndexOf('/') + 1) + path; 
    /*eslint-disable */
    var fn = __dependencies[path];
    if (!fn) {
      throw new Error('can not find template ' + path);
    }
    eval('fn = ' + fn);
    var d = __shallowCopy({}, __locals__);
    if (includeData) {
      d = __shallowCopy(d, includeData);
    }
    return fn(d, escape, rethrow);
  }.toString()
}

/**
 * Escape characters reserved in XML.
 *
 * This is simply an export of {@link module:utils.escapeXML}.
 *
 * If `markup` is `undefined` or `null`, the empty string is returned.
 *
 * @param {String} markup Input string
 * @return {String} Escaped string
 * @public
 * @func
 * */
exports.escapeXML = utils.escapeXML

/**
 * Express.js support.
 *
 * This is an alias for {@link module:ejs.renderFile}, in order to support
 * Express.js out-of-the-box.
 *
 * @func
 */

exports.__express = exports.renderFile

// Add require support
/* istanbul ignore else */
if (require.extensions) {
  require.extensions['.ejs'] = function (module, flnm) {
    var filename = flnm || /* istanbul ignore next */ module.filename
    var options = {
      filename: filename,
      client: true
    }
    var template = fs.readFileSync(filename).toString()
    var fn = exports.compile(template, options)
    module._compile('module.exports = ' + fn.toString() + ';', filename)
  }
}

/**
 * Version of EJS.
 *
 * @readonly
 * @type {String}
 * @public
 */

exports.VERSION = _VERSION_STRING

/* istanbul ignore if */
if (typeof window != 'undefined') {
  window.ejs = exports
}