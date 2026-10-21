(function(){
  'use strict';
  var root='/original-pages/'+"2006-kouhaku"+'/';
  var pages=new Set(["accounts/vipkohaku_second_01/sakuhin_01.htm","accounts/vipkohaku_second_01/sakuhin_02.htm","accounts/vipkohaku_second_01/sakuhin_04.htm","accounts/vipkohaku_second_01/sakuhin_05.htm","accounts/vipkohaku_second_01/sakuhin_08.htm","accounts/vipkohaku_second_01/sakuhin_09.htm","accounts/vipkohaku_second_01/sakuhin_10.htm","accounts/vipkohaku_second_01/sakuhin_11.htm","accounts/vipkohaku_second_02/index.html","accounts/vipkohaku_second_02/sakuhin_12.htm","accounts/vipkohaku_second_02/sakuhin_13.htm","accounts/vipkohaku_second_02/sakuhin_14.htm","accounts/vipkohaku_second_02/sakuhin_15.htm","accounts/vipkohaku_second_02/sakuhin_16.htm","accounts/vipkohaku_second_02/sakuhin_17.htm","accounts/vipkohaku_second_02/sakuhin_18.htm","accounts/vipkohaku_second_02/sakuhin_19.htm","accounts/vipkohaku_second_02/sakuhin_21.htm","accounts/vipkohaku_second_02/sakuhin_23.htm","accounts/vipkohaku_second_02/sakuhin_24.htm","accounts/vipkohaku_second_02/sakuhin_28.htm","accounts/vipkohaku_second_02/sakuhin_30.htm","accounts/vipkohaku_second_02/sakuhin_31.htm","accounts/vipkohaku_second_02/sakuhin_33.htm","accounts/vipkohaku_second_02/sakuhin_36.htm","accounts/vipkohaku_second_02/sakuhin_37.htm","accounts/vipkohaku_second_02/sakuhin_38.htm","accounts/vipkohaku_second_02/sakuhin_40.htm","accounts/vipkohaku_second_02/sakuhin_41.htm","accounts/vipkohaku_second_03/index.html","accounts/vipkohaku_second_03/sakuhin_42.htm","accounts/vipkohaku_second_03/sakuhin_44.htm","accounts/vipkohaku_second_03/sakuhin_46.htm","accounts/vipkohaku_second_03/sakuhin_48.htm","accounts/vipkohaku_second_03/sakuhin_49.htm","accounts/vipkohaku_second_04/index.html","accounts/vipkohaku_second_04/sakuhin_51.htm","accounts/vipkohaku_second_04/sakuhin_52.htm","accounts/vipkohaku_second_04/sakuhin_55.htm","accounts/vipkohaku_second_04/sakuhin_57.htm","accounts/vipkohaku_second_04/sakuhin_58.htm","accounts/vipkohaku_second_04/sakuhin_60.htm","accounts/vipkohaku_second_04/sakuhin_61.htm","accounts/vipkohaku_second_04/sakuhin_62.htm","accounts/vipkohaku_second_04/sakuhin_65.htm","accounts/vipkohaku_second_04/sakuhin_66.htm","accounts/vipkohaku_second_04/sakuhin_67.htm","accounts/vipkohaku_second_04/sakuhin_69.htm","accounts/vipkohaku_second_04/sakuhin_70.htm","accounts/vipkohaku_second_04/sakuhin_71.htm","accounts/vipkohaku_second_05/index.html","accounts/vipkohaku_second_05/sakuhin_72.htm","accounts/vipkohaku_second_05/sakuhin_73.htm","accounts/vipkohaku_second_05/sakuhin_75.htm","accounts/vipkohaku_second_05/sakuhin_76.htm","accounts/vipkohaku_second_05/sakuhin_77.htm","accounts/vipkohaku_second_05/sakuhin_78.htm","accounts/vipkohaku_second_05/sakuhin_79.htm","accounts/vipkohaku_second_05/sakuhin_80.htm","accounts/vipkohaku_second_05/sakuhin_81.htm","accounts/vipkohaku_second_05/sakuhin_82.htm","accounts/vipkohaku_second_05/sakuhin_83.htm","accounts/vipkohaku_second_05/sakuhin_84.htm","accounts/vipkohaku_second_05/sakuhin_85.htm","accounts/vipkohaku_second_05/sakuhin_86.htm","accounts/vipkohaku_second_05/sakuhin_87.htm","accounts/vipkohaku_second_05/sakuhin_88.htm","accounts/vipkohaku_second_05/sakuhin_89.htm","accounts/vipkohaku_second_05/sakuhin_90.htm","accounts/vipkohaku_second_06/index.html","accounts/vipkohaku_second_06/sakuhin_03.htm","accounts/vipkohaku_second_06/sakuhin_06.htm","accounts/vipkohaku_second_06/sakuhin_07.htm","accounts/vipkohaku_second_06/sakuhin_20.htm","accounts/vipkohaku_second_06/sakuhin_22.htm","accounts/vipkohaku_second_06/sakuhin_25.htm","accounts/vipkohaku_second_06/sakuhin_26.htm","accounts/vipkohaku_second_06/sakuhin_27.htm","accounts/vipkohaku_second_06/sakuhin_29.htm","accounts/vipkohaku_second_06/sakuhin_32.htm","accounts/vipkohaku_second_06/sakuhin_34.htm","accounts/vipkohaku_second_06/sakuhin_35.htm","accounts/vipkohaku_second_06/sakuhin_39.htm","accounts/vipkohaku_second_06/sakuhin_43.htm","accounts/vipkohaku_second_06/sakuhin_45.htm","accounts/vipkohaku_second_06/sakuhin_47.htm","accounts/vipkohaku_second_06/sakuhin_50.htm","accounts/vipkohaku_second_06/sakuhin_53.htm","accounts/vipkohaku_second_06/sakuhin_54.htm","accounts/vipkohaku_second_06/sakuhin_56.htm","accounts/vipkohaku_second_06/sakuhin_59.htm","accounts/vipkohaku_second_06/sakuhin_63.htm","accounts/vipkohaku_second_06/sakuhin_64.htm","accounts/vipkohaku_second_06/sakuhin_68.htm","accounts/vipkohaku_second_06/sakuhin_74.htm","accounts/vipkohaku_second_06/sakuhin_91.htm","accounts/vipkohaku_second_06/sakuhin_92.htm","etapage.htm","index.html","index_easy.htm","index_game.htm","menu.htm","review.htm","review2.htm","review3.htm","review4.htm","review5.htm","sanka.htm","tenpure.htm","top.htm","touhyou.htm","touhyou_kekka.htm"]);
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
