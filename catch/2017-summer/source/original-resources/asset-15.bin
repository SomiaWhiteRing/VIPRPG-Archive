$(function(){
	
	//＃＃＃＃＃ボタンの表示入れ替え＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃
	//ボタンの名称がbtnCh1ならば、ボタンを押したとき、通常のボタン(btnCh2)に切替
	$('body').on('click','button[name="btnCh1"]', function(e){
		$('button[name="btnCh1"]').attr("name", "btnCh2");
		$('.adj').css("height", "5px");
		for (i=1; i<=5; i++){
			btnSim(i);
		}
		//クッキー設定
		$.cookie("button", true, { expires: 7 });
	});
	//ボタンの名称がbtnCh2ならば、ボタンを押したとき、リッチなボタン(btnCh1)に切替
	$('body').on('click','button[name="btnCh2"]', function(e){
		$('button[name="btnCh2"]').attr("name", "btnCh1");
		$('.adj').css("height", "15px");
		var i;
		for (i=1; i<=5; i++){
			btnRich(i);
		}
		//クッキー破棄
		$.removeCookie("button");
	});
	//クッキー[button]が[true]ならば、ページ生成時に<button>やボタン形式の<a>をデフォルト設定にする
	//クッキーがない場合は特に何もしない
	if($.cookie("button")){
		$('button[name="btnCh1"]').attr("name", "btnCh2");
		$('.adj').css("height", "5px");
		for (i=1; i<=5; i++){
			btnSim(i);
		}
	}
	//関数
	function btnRich(num){
		$('.bEmp'+num).removeClass('bEmp'+num).addClass('button'+num);
	}
	function btnSim(num){
		$('.button'+num).removeClass('button'+num).addClass('bEmp'+num);
	}
});