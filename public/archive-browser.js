(function () {
  'use strict';
  var root = location.pathname.match(/^\/original-pages\/[^/]+\//);
  if (!root || parent === window) return;
  var stateType = 'archive-browser-state';
  var restoreType = 'archive-browser-restore';
  var activityType = 'archive-browser-activity';
  var documentId = Math.random().toString(36).slice(2);

  function children() { return Array.from(document.querySelectorAll('frame,iframe')); }
  function validPath(value) {
    return Array.isArray(value) && value.length <= 16 && value.every(function (i) { return Number.isInteger(i) && i >= 0 && i < 1000; });
  }
  function validUrl(value) {
    try {
      var url = new URL(value);
      // The shell validates the HTML inventory, including the host's clean URLs.
      return url.origin === location.origin && url.pathname.startsWith(root[0]);
    } catch { return false; }
  }
  function report(replace) {
    parent.postMessage({ type: stateType, path: [], url: location.href, documentId: documentId, replace: replace === true, loaded: document.readyState === 'complete' }, '*');
  }

  addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.type === 'archive-browser-query' && event.source === parent) {
      report();
      children().forEach(function (frame) { frame.contentWindow.postMessage({ type: 'archive-browser-query' }, '*'); });
      return;
    }
    if (!data || !validPath(data.path) || !validUrl(data.url)) return;
    var frames = children();
    if ((data.type === stateType || data.type === activityType) && typeof data.documentId === 'string') {
      var index = frames.findIndex(function (frame) { return frame.contentWindow === event.source; });
      if (index < 0) return;
      parent.postMessage({ type: data.type, path: [index].concat(data.path), url: data.url, documentId: data.documentId, replace: data.replace === true, loaded: data.loaded === true }, '*');
    } else if (data.type === restoreType && event.source === parent) {
      if (!data.path.length) {
        if (location.href !== data.url) location.replace(data.url);
      } else {
        var frame = frames[data.path[0]];
        if (frame) frame.contentWindow.postMessage({ type: restoreType, path: data.path.slice(1), url: data.url }, '*');
      }
    }
  });

  // Announce ancestors before their children; repeat after source onload handlers.
  report();
  addEventListener('load', report);
  addEventListener('pageshow', report);
  addEventListener('hashchange', report);
  addEventListener('popstate', report);
  ['pushState', 'replaceState'].forEach(function (method) {
    var original = history[method];
    history[method] = function () {
      var result = original.apply(this, arguments);
      report(method === 'replaceState');
      return result;
    };
  });
  ['click', 'submit', 'keydown'].forEach(function (type) {
    addEventListener(type, function (event) {
      if (event.isTrusted) parent.postMessage({ type: activityType, path: [], url: location.href, documentId: documentId }, '*');
    }, true);
  });
})();
