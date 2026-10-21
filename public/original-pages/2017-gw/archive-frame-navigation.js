(function(){
  'use strict';
  var root='/original-pages/'+"2017-gw"+'/';
  var pages=new Set(["about.html","games/00.html","games/01.html","games/02.html","games/03.html","games/04.html","games/05.html","games/06.html","games/07.html","games/08.html","games/09.html","games/10.html","games/11.html","games/12.html","games/13.html","games/14.html","games/15.html","games/16.html","games/17.html","games/18.html","games/19.html","games/20.html","games/21.html","games/22.html","games/23.html","games/24.html","games/25.html","games/26.html","games/27.html","games/28.html","games/29.html","games/30.html","games/31.html","games/32.html","games/33.html","games/34.html","games/35.html","games/36.html","games/37.html","games/38.html","games/39.html","games/40.html","games/41.html","games/42.html","games/43.html","games/44.html","games/45.html","games/46.html","games/47.html","games/48.html","games/49.html","games/50.html","games.html","index.html","menu.html","update.html"]);
  var kind='archive-local-frame-v1';
  function valid(data){
    if(!data||data.type!==kind||typeof data.target!=='string'||typeof data.url!=='string')return false;
    try{var u=new URL(data.url);return u.origin===location.origin&&u.pathname.startsWith(root)&&pages.has(decodeURIComponent(u.pathname.slice(root.length)))}catch(e){return false}
  }
  function children(){return Array.from(document.querySelectorAll('frame,iframe'))}
  function isRoot(){return parent===window||parent===top}
  function descend(data){
    var nodes=children(),found=nodes.find(function(f){return f.name===data.target});
    if(found){found.src=data.url;return}
    nodes.forEach(function(f){f.contentWindow.postMessage(Object.assign({},data,{down:true}),'*')});
  }
  function route(data){
    if(data.target==='_parent'){location.href=data.url;return}
    if(data.target!=='_top'){
      var found=children().find(function(f){return f.name===data.target});
      if(found){found.src=data.url;return}
    }
    if(!isRoot()){parent.postMessage(data,'*');return}
    if(data.target==='_top'){location.href=data.url;return}
    descend(data);
  }
  addEventListener('message',function(e){
    if(!valid(e.data))return;
    if(e.data.down){if(!isRoot()&&e.source===parent)descend(e.data);return}
    if(children().some(function(f){return f.contentWindow===e.source}))route(e.data);
  });
  addEventListener('click',function(e){
    if(e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
    var a=e.target.closest&&e.target.closest('a[href],area[href]');if(!a||a.hasAttribute('download'))return;
    var base=document.querySelector('base[target]');
    var target=a.getAttribute('target')||(base&&base.getAttribute('target'))||'_self';
    if(target==='_self'||target==='_blank'||target===window.name)return;
    var data={type:kind,target:target,url:a.href};if(!valid(data))return;
    e.preventDefault();e.stopImmediatePropagation();
    if(isRoot())route(data);else parent.postMessage(data,'*');
  },true);
})();
