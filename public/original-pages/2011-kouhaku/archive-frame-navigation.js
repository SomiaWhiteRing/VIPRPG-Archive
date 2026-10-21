(function(){
  'use strict';
  var root='/original-pages/'+"2011-kouhaku"+'/';
  var pages=new Set(["entry/000.html","entry/001.html","entry/002.html","entry/003.html","entry/004.html","entry/005.html","entry/006.html","entry/007.html","entry/008.html","entry/009.html","entry/010.html","entry/011.html","entry/012.html","entry/013.html","entry/014.html","entry/015.html","entry/016.html","entry/017.html","entry/018.html","entry/019.html","entry/020.html","entry/021.html","entry/022.html","entry/023.html","entry/024.html","entry/025.html","entry/026.html","entry/027.html","entry/028.html","entry/029.html","entry/030.html","entry/031.html","entry/032.html","entry/033.html","entry/034.html","entry/035.html","entry/036.html","entry/037.html","entry/038.html","entry/039.html","entry/040.html","entry/041.html","entry/042.html","entry/043.html","entry/044.html","entry/045.html","entry/046.html","entry/047.html","entry/048.html","entry/049.html","entry/050.html","entry/051.html","entry/052.html","entry/053.html","entry/054.html","entry/055.html","entry/056.html","entry/057.html","entry/058.html","entry/059.html","entry/060.html","entry/061.html","entry/062.html","entry/063.html","entry/064.html","entry/065.html","entry/066.html","entry/067.html","entry/068.html","entry/069.html","entry/070.html","entry/071.html","entry/072.html","entry/073.html","entry/074.html","entry/075.html","entry/076.html","entry/077.html","entry/078.html","entry/079.html","entry/080.html","entry/081.html","entry/082.html","entry/083.html","entry/084.html","entry/085.html","entry/086.html","entry/087.html","entry/088.html","entry/089.html","entry/090.html","entry/091.html","entry/092.html","entry/093.html","entry/094.html","entry/095.html","entry/096.html","entry/097.html","entry/entry_menu.html","entry.html","index.html","index_top.html","menu_top.html","page01.html","page02.html","page04.html","page05.html","page07_1.html"]);
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
