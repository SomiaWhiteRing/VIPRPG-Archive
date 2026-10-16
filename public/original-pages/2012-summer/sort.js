var oTRs;      // TRオブジェクトリスト
var nColId;    // ソート対象のカラムID
var sType;     // ソート方式（n:数値、s:文字列）

// idで指定されるテーブルの colId番目のカラムをソートする
// typeには n（数値）か s（文字列）のいずれかを指定する
function SortTable(id, colId, type) {
  var i, nRow, nCol;
  var oTABLE, oTBODY, oTDs;
  var aCells = new Array();
  var nRowIDs = new Array();

  // DOMをサポートしていなければ無視
  if (!document.getElementById) { return; }

  // カラム番号とソート方式を外部変数に覚えておく
  nColId = colId;
  sType = type;

  // TR要素のリストを取り出す
  oTABLE = document.getElementById(id);
  oTBODY = oTABLE.getElementsByTagName("TBODY")[0];
  oTRs = oTBODY.getElementsByTagName("TR");

  // テーブルの内容を覚えておく
  for (nRow = 0; nRow < oTRs.length; nRow++) {
    nRowIDs[nRow] = nRow;
    oTDs = oTRs[nRow].getElementsByTagName("*");
    aCells[nRow] = new Array();
    for (nCol = 0; nCol < oTDs.length; nCol++) {
      aCells[nRow][nCol] = oTDs[nCol].firstChild.nodeValue;
    }
  }

  // ソートする
  nRowIDs.sort(CompareRows);

  // 覚えていた内容をテーブルに書き戻す
  for (nRow = 0; nRow < oTRs.length; nRow++) {
    oTDs = oTRs[nRow].getElementsByTagName("*");
    for (nCol = 0; nCol < oTDs.length; nCol++) {
      oTDs[nCol].firstChild.nodeValue = aCells[nRowIDs[nRow]][nCol];
    }
  }
}

// テーブルソートのための比較関数
function CompareRows(a, b) {
  var sA = oTRs[a].getElementsByTagName("*")[nColId].firstChild.nodeValue;
  var sB = oTRs[b].getElementsByTagName("*")[nColId].firstChild.nodeValue;
  if (sType == "n") {
    sA = eval(sA);
    sB = eval(sB);
  }
  if (sA == sB) {
    return 0;
  } else if (sA > sB) {
    return 1;
  } else {
    return -1;
  }
}
