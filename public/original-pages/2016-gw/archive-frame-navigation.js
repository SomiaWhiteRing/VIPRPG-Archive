(function(){
  'use strict';
  var root='/original-pages/'+"2016-gw"+'/';
  var pages=new Set(["entry00.html","entry01.html","entry02.html","entry03.html","entry04.html","entry05.html","entry06.html","entry07.html","entry08.html","entry09.html","entry10.html","entry11.html","entry12.html","entry13.html","entry14.html","entry15.html","entry16.html","entry17.html","entry18.html","entry19.html","entry20.html","entry21.html","entry22.html","entry23.html","entry24.html","entry25.html","entry26.html","entry27.html","entry28.html","entry29.html","entry30.html","entry31.html","entry32.html","entry33.html","entry34.html","entry35.html","entry36.html","entry37.html","entry38.html","entry39.html","entry40.html","entry41.html","entry42.html","entry43.html","entry44.html","entry45.html","entry46.html","entry47.html","entry48.html","entry49.html","entry50.html","entry51.html","entry52.html","entry53.html","entry54.html","entry55.html","entry56.html","entry57.html","entry58.html","entry59.html","entry60.html","entry61.html","entry62.html","entry63.html","faq.html","index.html","intro.html","main.html","menu.html"]);
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
