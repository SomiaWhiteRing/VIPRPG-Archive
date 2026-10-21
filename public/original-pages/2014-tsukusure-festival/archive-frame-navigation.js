(function(){
  'use strict';
  var root='/original-pages/'+"2014-tsukusure-festival"+'/';
  var pages=new Set(["c_backdrop.html","c_battle.html","c_charset.html","c_faceset.html","c_ksg.html","c_movie.html","c_music.html","c_other.html","c_panorama.html","c_picture.html","c_sound.html","c_system.html","c_title.html","entry.html","index.html","top.html"]);
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
