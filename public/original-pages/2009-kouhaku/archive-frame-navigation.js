(function(){
  'use strict';
  var root='/original-pages/'+"2009-kouhaku"+'/';
  var pages=new Set(["gaiyou.htm","handin.htm","handin2.htm","hosoku.htm","index.htm","index_top.htm","menu.htm","sakuhin.htm","sakuhin_001.htm","sakuhin_002.htm","sakuhin_003.htm","sakuhin_004.htm","sakuhin_005.htm","sakuhin_006.htm","sakuhin_007.htm","sakuhin_008.htm","sakuhin_009.htm","sakuhin_010.htm","sakuhin_011.htm","sakuhin_012.htm","sakuhin_013.htm","sakuhin_014.htm","sakuhin_015.htm","sakuhin_016.htm","sakuhin_017.htm","sakuhin_018.htm","sakuhin_019.htm","sakuhin_020.htm","sakuhin_021.htm","sakuhin_022.htm","sakuhin_023.htm","sakuhin_024.htm","sakuhin_025.htm","sakuhin_026.htm","sakuhin_027.htm","sakuhin_028.htm","sakuhin_029.htm","sakuhin_030.htm","sakuhin_032.htm","sakuhin_033.htm","sakuhin_034.htm","sakuhin_035.htm","sakuhin_036.htm","sakuhin_037.htm","sakuhin_038.htm","sakuhin_039.htm","sakuhin_040.htm","sakuhin_041.htm","sakuhin_042.htm","sakuhin_043.htm","sakuhin_044.htm","sakuhin_045.htm","sakuhin_046.htm","sakuhin_047.htm","sakuhin_048.htm","sakuhin_049.htm","sakuhin_050.htm","sakuhin_051.htm","sakuhin_052.htm","sakuhin_053.htm","sakuhin_054.htm","sakuhin_055.htm","sakuhin_056.htm","sakuhin_057.htm","sakuhin_058.htm","sakuhin_059.htm","sakuhin_060.htm","sakuhin_061.htm","sakuhin_062.htm","sakuhin_063.htm","sakuhin_064.htm","sakuhin_065.htm","sakuhin_066.htm","sakuhin_067.htm","sakuhin_068.htm","sakuhin_069.htm","sakuhin_070.htm","sakuhin_071.htm","sakuhin_072.htm","sakuhin_073.htm","sakuhin_074.htm","sakuhin_075.htm","sakuhin_076.htm","sakuhin_077.htm","sakuhin_078.htm","sakuhin_079.htm","sakuhin_080.htm","sakuhin_081.htm","sakuhin_082.htm","sakuhin_083.htm","sakuhin_084.htm","sakuhin_085.htm","sakuhin_086.htm","sakuhin_087.htm","sakuhin_088.htm","sakuhin_089.htm","sakuhin_list2.htm","sakuhin_red.htm","sakuhin_top.htm"]);
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
