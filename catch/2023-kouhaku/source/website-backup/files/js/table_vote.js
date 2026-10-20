 //===============================================================
 //  テーブルソートの共通変数　設定要！
 //===============================================================
var gTabldID = 'sampleTable';  // テーブルのエリアのIDを設定
var gSortNum = 1;              // 1 : 数値に見える列は数値でソート
var gSortAa  = 1;              // 1 : 英大文字と小文字を区別しない
 
var gSortBtnRow = 0;
 
 //===============================================================
 //  オンロードでテーブル初期設定関数をCALL
 //===============================================================
window.onload = function() {
  tSortInit();
    
  //アンカー・スクロール設定ST
  $('a[href^="#"]').click(function(){
      
        var href = $(this).attr('href');
      
        $('#block-'+href.slice(1)).attr('checked', true).prop('checked', true).change();{
            
            $("html,body").animate({scrollTop:$(href).offset().top-150});
            
        }
    });
  //アンカー・スクロール設定ED
}

function tSortInit(){
 //===============================================================
 //  テーブルの初期設定
 //===============================================================
 
  var wTABLE  = document.getElementById(gTabldID);
  var wTR     = wTABLE.rows;
  var wAddBtn = '';
 
  // --- テーブル内を検索してソートボタンを付ける ----------------
  for(var i=0; i < wTR.length; i++){
 
    var wTD     = wTABLE.rows[i].cells;
    for(var j=0; j < wTD.length; j++){
 
      if(wTD[j].getAttribute('cmanSortBtn') !== null){
 
        wAddBtn  = '<div class="tsImgArea">';
        wAddBtn += '<svg class="tsImg" id="ts_A_'+j+'" onclick="tSort(this)"><path d="M4 0 L0 6 L8 6 Z"></path></svg>';
        wAddBtn += '<svg class="tsImg" id="ts_D_'+j+'" onclick="tSort(this)"><path d="M0 0 L8 0 L4 7 Z"></path></svg>';
        wAddBtn += '</div>';
 
        wTD[j].innerHTML = wTD[j].innerHTML+wAddBtn;
      }
    }
 
    // --- ボタンを付けたら以降の行は無視する --------------------
    if(wAddBtn != ''){
      gSortBtnRow = i;
      break;
    }
  }
}

function tSort(argObj){
 //===============================================================
 //  ソート実行
 //===============================================================
 
   // 「ts_A_1」形式 [1]:A-昇順,D-降順  [2]:列番号
  var wSortKey  = argObj.id.split('_');
 
  var wTABLE    = document.getElementById(gTabldID);
  var wTR       = wTABLE.rows;
  var wItem     = [];              // クリックされた列の値
  var wItemSort = [];              // クリックされた列の値（項目ソート後）
  var wMoveRow  = [];              // 元の行位置（行削除考慮位置）
  var wNotNum   = 0;               // 1 : 数字でない
  var wStartRow = gSortBtnRow + 1; // ソートを開始する行はボタンの次の行
 
  // ------------------------------------------------------
  //  クリックされた列の値を取得する
  // ------------------------------------------------------
  for(var i=wStartRow; i < wTR.length; i++){
    var j = i - wStartRow;
    wItem[j] = wTR[i].cells[wSortKey[2]].innerText.toString();
 
    if(wItem[j].match(/^[-]?[0-9,\.]+$/)){
    }else{
        wNotNum = 1;
    }
 
  }
  // ソート用に配列をコピー
  wItemSort = wItem.slice(0, wItem.length);
 
  // ------------------------------------------------------
  //  列の値でソートを実行
  // ------------------------------------------------------
  if(wSortKey[1] == 'A'){
    if((gSortNum == 1)&&(wNotNum == 0)){
      wItemSort.sort(sortNumA);           // 数値で昇順
    }else{
      wItemSort.sort(sortStrA);           // 文字で昇順
    }
  }else{
    if((gSortNum == 1)&&(wNotNum == 0)){
      wItemSort.sort(sortNumD);           // 数値で降順
    }else{
      wItemSort.sort(sortStrD);           // 文字で降順
    }
  }
 
  // ------------------------------------------------------
  //  行の入れ替え順を取得
  //    ソート前後の列の値を比較して行の移動順を確定
  //    配列を削除して前詰めしている（移動時も同じ動き）
  // ------------------------------------------------------
  for(var i=0; i < wItemSort.length; i++){
     for(var j=0; j < wItem.length; j++){
      if(wItemSort[i] == wItem[j]){
          wMoveRow[i] = j + wStartRow;
          wItem.splice(j, 1);
          break;
      }
    }
  }
 
  // ------------------------------------------------------
  //  ソート順に行を移動
  // ------------------------------------------------------
  for(var i=0; i < wMoveRow.length; i++){
 
 
    var wMoveTr = wTABLE.rows[wMoveRow[i]];                  // 移動対象
    var wLastTr = wTABLE.rows[wTABLE.rows.length - 1];   // 最終行
 
    // 最終行にコピーしてから移動元を削除
    wLastTr.parentNode.insertBefore(wMoveTr.cloneNode(true), wLastTr.nextSibling);
    wTABLE.deleteRow(wMoveRow[i]);
 
  }
 
  // ------------------------------------------------------
  //  クリックされたソートボタンの色付け
  // ------------------------------------------------------
  var elmImg = document.getElementsByClassName('tsImg');
  for (var i=0; i < elmImg.length; i++) {
 
    if(elmImg[i].id == argObj.id){
      elmImg[i].style.backgroundColor = '#ffff00';
    }else{
      elmImg[i].style.backgroundColor = '';
    }
 
  }
 
}

function sortNumA(a, b) {
 //===============================================================
 //  数字のソート関数（昇順）
 //===============================================================
  a = parseInt(a.replace(/,/g, ''));
  b = parseInt(b.replace(/,/g, ''));
  return a - b;
}

function sortNumD(a, b) {
 //===============================================================
 //  数字のソート関数（降順）
 //===============================================================
  a = parseInt(a.replace(/,/g, ''));
  b = parseInt(b.replace(/,/g, ''));
  return b - a;
}

function sortStrA(a, b){
 //===============================================================
 //  文字のソート関数（昇順）
 //===============================================================
  a = a.toString();
  b = b.toString();
  if(gSortAa == 1){             // 1 : 英大文字小文字を区別しない
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if     (a < b){ return -1; }
  else if(a > b){ return  1; }
  return 0;
}

function sortStrD(a, b){
 //===============================================================
 //  文字のソート関数（降順）
 //===============================================================
  a = a.toString();
  b = b.toString();
  if(gSortAa == 1){             // 1 : 英大文字小文字を区別しない
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
 
  if     (b < a){ return -1; }
  else if(b > a){ return  1; }
  return 0;
}
