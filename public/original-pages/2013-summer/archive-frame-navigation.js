(function(){
  'use strict';
  var root='/original-pages/'+"2013-summer"+'/';
  var pages=new Set(["index.html","main.html","menu.html","ss/0.html","ss/1.html","ss/10.html","ss/11.html","ss/12.html","ss/13.html","ss/14.html","ss/15.html","ss/16.html","ss/17.html","ss/18.html","ss/19.html","ss/2.html","ss/20.html","ss/21.html","ss/22.html","ss/23.html","ss/24.html","ss/25.html","ss/26.html","ss/27.html","ss/28.html","ss/29.html","ss/3.html","ss/30.html","ss/31.html","ss/32.html","ss/33.html","ss/34.html","ss/35.html","ss/36.html","ss/37.html","ss/38.html","ss/39.html","ss/4.html","ss/40.html","ss/41.html","ss/42.html","ss/43.html","ss/44.html","ss/45.html","ss/46.html","ss/47.html","ss/48.html","ss/49.html","ss/5.html","ss/50.html","ss/51.html","ss/52.html","ss/53.html","ss/54.html","ss/55.html","ss/56.html","ss/57.html","ss/58.html","ss/59.html","ss/6.html","ss/60.html","ss/61.html","ss/62.html","ss/63.html","ss/64.html","ss/65.html","ss/66.html","ss/67.html","ss/68.html","ss/69.html","ss/7.html","ss/70.html","ss/71.html","ss/8.html","ss/9.html"]);
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
