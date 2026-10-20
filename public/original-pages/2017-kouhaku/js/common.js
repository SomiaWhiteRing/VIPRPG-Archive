$(function(){
	
	//＃＃＃＃＃ボタンの表示方法＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃
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


	//＃＃＃＃＃表示と非表示入れ替え＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃＃
	//非表示
	$('body').on('click touchstart','.hidden', function(){
		$(this).text('-表示-');							//文字を表示に切替
		$(this).removeClass('hidden').addClass('show');	//クラス"hidden"を消してクラス"show"を付与
		var id = '#' + $(this).attr('id');				//隠すid属性を指定
		$(id + 'A').hide();								//隠す
		setHideCookie(id, 'hide');						//隠したidをクッキー"hide"に格納
	});
	//表示
	$('body').on('click touchstart', '.show', function(){
		$(this).text('-非表示-');						//文字を非表示に切替
		$(this).removeClass('show').addClass('hidden');	//クラス"show"を消してクラス"hidden"を付与
		var id = '#' + $(this).attr('id');				//表示するid属性を指定
		$(id + 'A').show();								//表示
		removeHideCookie(id, 'hide');					//クッキー"hide"から表示したIDを破棄
	});
			
	//関数
	//非表示にしたidをクッキーにて保存、クッキーは配列にて保存
	function setHideCookie(id, c_name){
		if($.cookie(c_name)){
			//既にクッキーが存在する場合、末尾にidを追加
			var old_hide = decodeURI($.cookie(c_name));	//クッキーの中身をURLでコードする
			var new_hide = old_hide + id + ',';			//文字列の末尾にID追加

		}else{
			var new_hide = id + ',';					//","を付けたし
		}
		$.cookie(c_name, new_hide, { expires: 30 });	//クッキー書き込み		
		console.log(new_hide);							//コンソールログにも書き込み
	}
	//表示にしたidをクッキーから削除
	function removeHideCookie(id, c_name){
		if($.cookie(c_name)){
			//既にクッキーが存在することが前提
			//非表示にしていたIDを削除する
			var old_hide = decodeURI($.cookie(c_name));	//クッキーの中身をURLでコードする
			var data = old_hide.split(',');				//データを","で区切る
			var splicenum = $.inArray(id, data);		//非表示のIDに対応する配列の番号を探す
			
			data.splice(splicenum, 1);					//配列からIDの要素を消す
			new_hide = data								//新データ取得
			$.cookie(c_name, new_hide, { expires: 30 });//クッキー書き込み		
			console.log(new_hide);						//コンソールログにも書き込み
		}
	}
	//ページ読み込み時にクッキーに応じて非表示
	/*function readCookie(name){
		alert(name);
		if($.cookie('hide')){
			//既にクッキーが存在することが前提
			//非表示に対応するIDを非表示にする
			var hide = decodeURI($.cookie('hide'));					//クッキーの中身をURLでコードする
			var data = hide.split(',');								//データを","で区切る
			$.each(data, function(i, id){
				//console.log(id)
				if(id !==''){
					$(id).text('-表示-');							//文字を表示に切替
					$(id).removeClass('hidden').addClass('show');	//クラス"hidden"を消してクラス"show"を付与
					$(id + 'A').hide();								//隠す
				}
			});
		}
	}*/
});