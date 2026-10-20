      
 //===============================================================
 //  フィルタテーブルの共通変数　設定要！
 //===============================================================
var gTabldID = 'sampleTable';  // テーブルのエリアのIDを設定
var gTfStartRow = 0;
var gTfColList  = [];             // ボタンが配置されている列番号
var gTfListSave = {};             // フィルタリストの保存状態
 
 //===============================================================
 //  オンロードでテーブル初期設定関数をCALL
 //===============================================================
window.onload = function() {
  tFilterInit();
}

function tFilterInit(){
 //==============================================================
 //  テーブルの初期設定
 //==============================================================
  var wTABLE  = document.getElementById(gTabldID);
  var wTR     = wTABLE.rows;
  var wAddBtn = '';
 
  // ------------------------------------------------------------
  //   テーブル内をフィルタボタンを付ける
  // ------------------------------------------------------------
  for(var i=0; i < wTR.length; i++){
 
    var wTD     = wTABLE.rows[i].cells;
 
    for(var j=0; j < wTD.length; j++){
 
      // --- 「cmanFilterBtn」の定義があるセルを対象とする ------
      if(wTD[j].getAttribute('cmanFilterBtn') !== null){
 
        // --- フィルタ対象はボタンの次の行から -----------------
        gTfStartRow = i + 1;
 
        // --- ボタンを追加（画像はsvgを使用） ------------------
        wAddBtn  = '<div class="tfArea">';
        wAddBtn += '<svg class="tfImg" id="tsBtn_'+j+'" onclick="tFilterCloseOpen('+j+')"><path d="M0 0 L9 0 L6 4 L6 8 L3 8 L3 4Z"></path></svg>';
        wAddBtn += '<div class="tfList" id="tfList_'+j+'" style="display:none">';
        wAddBtn += tFilterCreate(j);
        wAddBtn += '</div>';
        wAddBtn += '</div>';
        wTD[j].innerHTML = wTD[j].innerHTML+wAddBtn;
 
        // --- フィルタボタンなる列を保存 -----------------------
        gTfColList.push(j);
      }
    }
 
    // --- ボタンを付けたら以降の行は無視する -------------------
    if(wAddBtn != ''){
      gSortBtnRow = i;
      break;
    }
 
  }
}

function tFilterCreate(argCol){
 //==============================================================
 //  指定列のフィルタリスト作成
 //==============================================================
 
  var wTABLE    = document.getElementById(gTabldID);
  var wTR       = wTABLE.rows;
  var wItem     = [];              // クリックされた列の値
  var wNotNum   = 0;               // 1 : 数字でない
  var wItemSave = {};              // フィルタに設定した値がキー
  var rcList    = '';              // 返すフィルタリスト
 
  // ------------------------------------------------------------
  //  クリックされた列の値を取得する
  // ------------------------------------------------------------
  for(var i=gTfStartRow; i < wTR.length; i++){
    var j = i - gTfStartRow;
 
    wItem[j] = wTR[i].cells[argCol].innerText.toString();
 
    if(wItem[j].match(/^[-]?[0-9,\.]+$/)){
    }else{
        wNotNum = 1;
    }
 
  }
 
  // ------------------------------------------------------------
  //  列の値でソートを実行
  // ------------------------------------------------------------
    if(wNotNum == 0){
      wItem.sort(sortNumA);           // 数値で昇順
    }else{
      wItem.sort(sortStrA);           // 文字で昇順
    }
 
  // ------------------------------------------------------------
  //  「すべて」のチェックボックス作成
  // ------------------------------------------------------------
  var wItemId =  id='tfData_ALL_'+argCol;
 
  rcList += '<div class="tfMeisai">';
  rcList += '<input type="checkbox" id="'+wItemId+'" checked onclick="tFilterAllSet('+argCol+')">';
  rcList += '<label for="'+wItemId+'">(すべて)</label>';
  rcList += '</div>';
 
  // ------------------------------------------------------------
  //  列の値でフィルタのチェックボックスを作成する
  //    チェックボックスはformで囲む
  // ------------------------------------------------------------
  rcList += '<form name="tfForm_'+argCol+'">';
 
  for(var i=0; i < wItem.length; i++){
 
    wVal = trim(wItem[i]);
 
    if(wVal in wItemSave){
      // ---値でチェックボックスが作成されている(重複) ----------
    }else{
 
      // ---チェックボックスの作成 ------------------------------
      wItemId =  id='tfData_'+argCol+'_r'+i;
      rcList += '<div class="tfMeisai">';
      rcList += '<input type="checkbox" id="'+wItemId+'" value="'+wVal+'" checked onclick="tFilterClick('+argCol+')">';
      rcList += '<label for="'+wItemId+'">'+( wVal=='' ? '(空白)' : wVal )+'</label>';
      rcList += '</div>';
 
      // ---重複判定用にチェックボックスの値を保存 --------------
      wItemSave[wVal]='1';
    }
  }
  rcList += '</form>';
 
  // ------------------------------------------------------------
  //  文字抽出のinputを作成
  // ------------------------------------------------------------
  rcList += '<div class="tfInStr">';
  rcList += '<input type="text" placeholder="含む文字抽出" id="tfInStr_'+argCol+'">';
  rcList += '</div>';
 
  // ------------------------------------------------------------
  //  「OK」「Cancel」ボタンの作成
  // ------------------------------------------------------------
  rcList += '<div class="tfBtnArea">';
  rcList += '<input type="button" value="OK" onclick="tFilterGo()">';
  rcList += '<input type="button" value="Cancel" onclick="tFilterCancel('+argCol+')">';
  rcList += '</div>';
 
  // ------------------------------------------------------------
  //  作成したhtmlを返す
  // ------------------------------------------------------------
  return rcList;
 
}

function tFilterClick(argCol){
 //==============================================================
 //  フィルタリストのチェックボックスクリック
 //    「すべて」のチェックボックスと整合性を合わせる
 //==============================================================
  var wForm   = document.forms['tfForm_'+argCol];
  var wCntOn  = 0;
  var wCntOff = 0;
  var wAll    = document.getElementById('tfData_ALL_'+argCol);   // 「すべて」のチェックボックス
 
  // --- 各チェックボックスの状態を集計する ---------------------
  for (var i = 0; i < wForm.elements.length; i++){
    if(wForm.elements[i].type == 'checkbox'){
      if (wForm.elements[i].checked) { wCntOn++;  }
      else                           { wCntOff++; }
    }
  }
 
  // --- 各チェックボックス集計で「すべて」を整備する -----------
  if((wCntOn == 0)||(wCntOff == 0)){
    wAll.checked = true;             // 「すべて」をチェックする
    tFilterAllSet(argCol);           // 各フィルタのチェックする
  }else{
     wAll.checked = false;           // 「すべて」をチェックを外す
  }
}

function tFilterCancel(argCol){
 //==============================================================
 //  キャンセルボタン押下
 //==============================================================
 
  tFilterSave(argCol, 'load');    // フィルタ条件の復元
  tFilterCloseOpen('');           // フィルタリストを閉じる
 
}

function tFilterGo(){
 //===============================================================
 //  フィルタの実行
 //===============================================================
  var wTABLE  = document.getElementById(gTabldID);
  var wTR     = wTABLE.rows;
 
  // ------------------------------------------------------------
  //  全ての非表示を一旦クリア
  // ------------------------------------------------------------
  for(var i = 0; i < wTR.length; i++){
    if(wTR[i].getAttribute('cmanFilterNone') !== null){
      wTR[i].removeAttribute('cmanFilterNone');
    }
  }
 
  // ------------------------------------------------------------
  //  フィルタボタンのある列を繰り返す
  // ------------------------------------------------------------
  for(var wColList = 0; wColList < gTfColList.length; wColList++){
    var wCol       = gTfColList[wColList];
    var wAll       = document.getElementById('tfData_ALL_'+wCol);     // 「すべて」のチェックボックス
    var wItemSave  = {};
    var wFilterBtn =  document.getElementById('tsBtn_'+wCol);
    var wFilterStr =  document.getElementById('tfInStr_'+wCol);
 
    var wForm      = document.forms['tfForm_'+wCol];
    // -----------------------------------------------------------
    //  チェックボックスの整備（「すべて」の整合性）
    // -----------------------------------------------------------
    for (var i = 0; i < wForm.elements.length; i++){
      if(wForm.elements[i].type == 'checkbox'){
        if (wForm.elements[i].checked) {
          wItemSave[wForm.elements[i].value] = 1;      // チェックされている値を保存
        }
      }
    }
 
    // -----------------------------------------------------------
    //  フィルタ（非表示）の設定
    // -----------------------------------------------------------
    if((wAll.checked)&&(trim(wFilterStr.value) == '')){
      wFilterBtn.style.backgroundColor = '';              // フィルタなし色
    }
    else{
      wFilterBtn.style.backgroundColor = '#ffff00';       // フィルタあり色
 
      for(var i=gTfStartRow; i < wTR.length; i++){
 
        var wVal = trim(wTR[i].cells[wCol].innerText.toString());
 
        // --- チェックボックス選択によるフィルタ ----------------
        if(!wAll.checked){
          if(wVal in wItemSave){
          }
          else{
            wTR[i].setAttribute('cmanFilterNone','');
          }
        }
 
        // --- 抽出文字によるフィルタ ----------------------------
        if(wFilterStr.value != ''){
          reg = new RegExp(wFilterStr.value);
          if(wVal.match(reg)){
          }
          else{
            wTR[i].setAttribute('cmanFilterNone','');
          }
        }
      }
    }
  }
 
  tFilterCloseOpen('');
}

function tFilterSave(argCol, argFunc){
 //==============================================================
 //  フィルタリストの保存または復元
 //==============================================================
 
  // ---「すべて」のチェックボックス値を保存 ------------------
  var wAllCheck = document.getElementById('tfData_ALL_'+argCol);
  if(argFunc == 'save'){
    gTfListSave[wAllCheck.id] = wAllCheck.checked;
  }else{
    wAllCheck.checked = gTfListSave[wAllCheck.id];
  }
 
  // --- 各チェックボックス値を保存 ---------------------------
  var wForm    = document.forms['tfForm_'+argCol];
  for (var i = 0; i < wForm.elements.length; i++){
    if(wForm.elements[i].type == 'checkbox'){
      if(argFunc == 'save'){
        gTfListSave[wForm.elements[i].id] = wForm.elements[i].checked;
      }else{
        wForm.elements[i].checked = gTfListSave[wForm.elements[i].id];
      }
    }
  }
 
  // --- 含む文字の入力を保存 ---------------------------------
  var wStrInput = document.getElementById('tfInStr_'+argCol);
  if(argFunc == 'save'){
    gTfListSave[wStrInput.id] = wStrInput.value;
  }else{
    wStrInput.value = gTfListSave[wStrInput.id];
  }
}

function tFilterCloseOpen(argCol){
 //==============================================================
 //  フィルタを閉じて開く
 //==============================================================
 
  // --- フィルタリストを一旦すべて閉じる -----------------------
  for(var i=0; i < gTfColList.length; i++){
    document.getElementById("tfList_"+gTfColList[i]).style.display = 'none';
  }
 
  // --- 指定された列のフィルタリストを開く ---------------------
  if(argCol != ''){
    document.getElementById("tfList_"+argCol).style.display = '';
 
    // --- フィルタ条件の保存（キャンセル時に復元するため） -----
    tFilterSave(argCol, 'save');
 
  }
}

function tFilterAllSet(argCol){
 //==============================================================
 //  「すべて」のチェック状態に合わせて、各チェックをON/OFF
 //==============================================================
  var wChecked = false;
  var wForm    = document.forms['tfForm_'+argCol];
 
  if(document.getElementById('tfData_ALL_'+argCol).checked){
    wChecked = true;
  }
 
  for (var i = 0; i < wForm.elements.length; i++){
    if(wForm.elements[i].type == 'checkbox'){
      wForm.elements[i].checked = wChecked;
    }
  }
}

function sortNumA(a, b) {
 //==============================================================
 //  数字のソート関数（昇順）
 //==============================================================
  a = parseInt(a.replace(/,/g, ''));
  b = parseInt(b.replace(/,/g, ''));
 
  return a - b;
}

function sortStrA(a, b){
 //==============================================================
 //  文字のソート関数（昇順）
 //==============================================================
  a = a.toString().toLowerCase();  // 英大文字小文字を区別しない
  b = b.toString().toLowerCase();
 
  if     (a < b){ return -1; }
  else if(a > b){ return  1; }
  return 0;
}

function trim(argStr){
 //==============================================================
 //  trim
 //==============================================================
  var rcStr = argStr;
  rcStr	= rcStr.replace(/^[ 　\r\n]+/g, '');
  rcStr	= rcStr.replace(/[ 　\r\n]+$/g, '');
  return rcStr;
}