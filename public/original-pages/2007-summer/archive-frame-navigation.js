(function(){
  'use strict';
  var root='/original-pages/'+"2007-summer"+'/';
  var pages=new Set(["2007p/index.html","2007r/index.html","2007r/menu.html","2007r/top.html","about.html","index.html","index2.html","link.html","menu.html","sanka.html","ss.html","ss0.html","ss1.html","ss10.html","ss11.html","ss12.html","ss13.html","ss14.html","ss15.html","ss16.html","ss17.html","ss18.html","ss19.html","ss2.html","ss20.html","ss21.html","ss22.html","ss23.html","ss24.html","ss25.html","ss26.html","ss27.html","ss28.html","ss29.html","ss3.html","ss30.html","ss31.html","ss32.html","ss33.html","ss34.html","ss35.html","ss36.html","ss37.html","ss38.html","ss39.html","ss4.html","ss40.html","ss41.html","ss42.html","ss43.html","ss44.html","ss45.html","ss46.html","ss47.html","ss48.html","ss49.html","ss5.html","ss50.html","ss51.html","ss52.html","ss53.html","ss54.html","ss55.html","ss56.html","ss57.html","ss58.html","ss59.html","ss6.html","ss60.html","ss61.html","ss62.html","ss63.html","ss64.html","ss65.html","ss66.html","ss67.html","ss68.html","ss69.html","ss7.html","ss70.html","ss71.html","ss72.html","ss73.html","ss74.html","ss75.html","ss76.html","ss77.html","ss78.html","ss79.html","ss8.html","ss80.html","ss81.html","ss82.html","ss83.html","ss84.html","ss85.html","ss86.html","ss87.html","ss88.html","ss89.html","ss9.html","ss90.html","ss91.html","ss92.html","ss93.html","ss94.html","ss95.html","ss96.html","top.html"]);
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
