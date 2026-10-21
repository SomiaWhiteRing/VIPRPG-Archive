(function(){
  'use strict';
  var root='/original-pages/'+"2008-kouhaku"+'/';
  var pages=new Set(["detail.html","index.html","kantan.html","sakuhin_1.html","sakuhin_10.html","sakuhin_100.html","sakuhin_101.html","sakuhin_102.html","sakuhin_103.html","sakuhin_104.html","sakuhin_105.html","sakuhin_106.html","sakuhin_107.html","sakuhin_108.html","sakuhin_109.html","sakuhin_11.html","sakuhin_110.html","sakuhin_111.html","sakuhin_112.html","sakuhin_113.html","sakuhin_114.html","sakuhin_115.html","sakuhin_116.html","sakuhin_117.html","sakuhin_118.html","sakuhin_119.html","sakuhin_12.html","sakuhin_120.html","sakuhin_121.html","sakuhin_122.html","sakuhin_123.html","sakuhin_124.html","sakuhin_125.html","sakuhin_13.html","sakuhin_14.html","sakuhin_15.html","sakuhin_16.html","sakuhin_17.html","sakuhin_18.html","sakuhin_19.html","sakuhin_2.html","sakuhin_20.html","sakuhin_21.html","sakuhin_22.html","sakuhin_23.html","sakuhin_24.html","sakuhin_25.html","sakuhin_26.html","sakuhin_27.html","sakuhin_28.html","sakuhin_29.html","sakuhin_3.html","sakuhin_30.html","sakuhin_31.html","sakuhin_32.html","sakuhin_33.html","sakuhin_34.html","sakuhin_35.html","sakuhin_36.html","sakuhin_37.html","sakuhin_38.html","sakuhin_39.html","sakuhin_4.html","sakuhin_40.html","sakuhin_41.html","sakuhin_42.html","sakuhin_43.html","sakuhin_44.html","sakuhin_45.html","sakuhin_46.html","sakuhin_47.html","sakuhin_48.html","sakuhin_49.html","sakuhin_5.html","sakuhin_50.html","sakuhin_51.html","sakuhin_52.html","sakuhin_53.html","sakuhin_54.html","sakuhin_55.html","sakuhin_56.html","sakuhin_57.html","sakuhin_58.html","sakuhin_59.html","sakuhin_6.html","sakuhin_60.html","sakuhin_61.html","sakuhin_62.html","sakuhin_63.html","sakuhin_64.html","sakuhin_65.html","sakuhin_66.html","sakuhin_67.html","sakuhin_68.html","sakuhin_69.html","sakuhin_7.html","sakuhin_70.html","sakuhin_71.html","sakuhin_72.html","sakuhin_73.html","sakuhin_74.html","sakuhin_75.html","sakuhin_76.html","sakuhin_77.html","sakuhin_78.html","sakuhin_79.html","sakuhin_8.html","sakuhin_80.html","sakuhin_81.html","sakuhin_82.html","sakuhin_83.html","sakuhin_84.html","sakuhin_85.html","sakuhin_86.html","sakuhin_87.html","sakuhin_88.html","sakuhin_89.html","sakuhin_9.html","sakuhin_90.html","sakuhin_91.html","sakuhin_92.html","sakuhin_93.html","sakuhin_94.html","sakuhin_95.html","sakuhin_96.html","sakuhin_97.html","sakuhin_98.html","sakuhin_99.html","sakuhin_aka.html","sakuhin_all.html","sakuhin_frame.html","sakuhin_siro.html","top1.html","top2.html","top3.html","top4.html"]);
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
