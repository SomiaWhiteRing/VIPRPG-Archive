
		
		function getDate(ms) {
			let date = new Date(Number(ms));
			return (date.getMonth() + 1) + "/" + date.getDate();
		}
		function ssu(img) {
			$("#ss_img").attr("src", `/img/${img}`);
		}
		function esc(str) {
			str = str.replace(/>/g, "&gt;");
			str = str.replace(/</g, "&lt;")
			str = str.replace(/\r?\n/g, '<br>');
			return str;
		}
		function forum(url, num) {
			if (url.match(/ux\.getuploader\.com/) || url.match(/jbbs\.shitaraba\.net/)) {
				parent.frame1.location.href = `../menu.html?id=${num}&forum=true`;
				location.href = url;
			} else {
				window.open(url);
			}

		}

		let data_h, data_s;
		$( document ).ready(function() {
			if (platform.name == 'IE') {

				$("#header").html("");

				$("#content").html("このサイトはInternet Explorerには対応していません。<br>" + 
					"Internet Explorerが長らく更新されておらず、機能に乏しく、脆弱性も高いブラウザであるためです。<br>" + 
					"<a href='https://www.google.com/intl/ja/chrome/'>Chrome</a>、 " + 
					"<a href='https://www.mozilla.org/ja/firefox/new/'>Firefox</a>、" + 
					"<a href='microsoft-edge:" + location.origin + "'>Microsoft Edge</a>" +
					"など別のブラウザをご利用ください。");

			} else {

				$("#back").attr("href", `${window.location.origin}`)
				
				$.ajax({
					type : 'GET',
					url : 'https://viprpg-gw2020.herokuapp.com/entries',
					dataType : 'json',
					timeout : 5000,
					async : false,
					success: function(json) {
						data_h = json;
					},
					error: function(XMLHttpRequest, textStatus, errorThrown) {
					}
				});

				$.ajax({
					type : 'GET',
					url : './games.json',
					dataType : 'json',
					timeout : 2000,
					async : false,
					success: function(json) {
						data_s = json;
					},
					error: function(XMLHttpRequest, textStatus, errorThrown) {
					}
				});
				
				if (!data_h) {
					$.ajax({
						type : 'GET',
						url : './data_h_local.json',
						dataType : 'json',
						timeout : 2000,
						async : false,
						success: function(json) {
							data_h = json;
						},
						error: function(XMLHttpRequest, textStatus, errorThrown) {
						}
					});
				}
				let c;
				let num = window.location.search.match(/id\=\d+/);
				if (num) {
					num = Number(num[0].match(/\d+/)[0]);
				} else {
					num = 0;
				}
				if (num > data_s.games.length) {
					parent.location.href='../?id=' + data_s.games.length;
				}

				// sample >>>

				data_h.games.unshift({
					gameid : 0,
					name_game :"サンプル",
					name_author : "管理人",
					genre : "サンプルゲーム",
					tool : "Steam2003",
					stream : "18歳以上は不可",
					comment : "ダーエロとメカゴが主人公の弾幕STGです。\n現在ステージ2までですが時間があればステージ3も作るかも。\n難易度は東方換算でEasy～Normal程度。\n\n一部不適切な表現を含むので注意。\nおまけの素材も同梱しています。",
					game_url : ["https://ux.getuploader.com/vipgw2020_game/download/118","","","",""],
					modified : "6/2"
				});
				data_s.games.unshift({
					icon : "default_icon.png",
					ss : ["default_ss1.png", "default_ss2.png"],
					forum : "https://jbbs.shitaraba.net/bbs/read.cgi/game/60946/1587008069/l1000","a_com":"エントリー直後のコメントの他、クリアしたら追加でコメントを書いていこうと思います。"
				});

				// <<<

				// default_img

				if (data_s.games[num].icon === "") {
					data_s.games[num].icon = "default_icon.png";
				}
				let im = 0;
				for (let c = 0; c < 4; c++) {
					if (!data_s.games[num].ss[c] || data_s.games[num].ss === "") {
						im++;
					}
				}
				if (im == 4) {
					data_s.games[num].ss[0] = "default_ss1.png";
				}

				$("#icon").attr('src', `/img/${data_s.games[num].icon}`)
				$("#name_game").html(`
					&nbsp;<b>No.${num}&nbsp;&nbsp;
					${esc(data_h.games[num].name_game)}</b>
				`);
				$("#ss_img").attr("src", `/img/${data_s.games[num].ss[0]}`);
				let link = "";
				for (let i = 0; i < data_s.games[num].ss.length; i++) {
					if (data_s.games[num].ss[i] !== "") {
						if (i != 0) { link = link + " / " }
						link = `${link}<a href="javascript:ssu('${data_s.games[num].ss[i]}')">SS${i + 1}</a>&nbsp;`;
					}
				}
				$("#ss_link").html(link);
				$("#name_author").html(`作者名：${esc(data_h.games[num].name_author)}`);
				$("#genre").html(`ジャンル：${esc(data_h.games[num].genre)}`);
				$("#tool").html(`ツール：${esc(data_h.games[num].tool)}`);
				$("#stream").html(`配信/動画投稿の許可：${esc(data_h.games[num].stream)}`);

				$("#fm").html(`<a href="javascript:forum('${data_s.games[num].forum}', ${num})">感想スレ</a>`);
				let dl = "";
				if (data_h.games[num].game_url[0] === "posted") {
					dl = "提出済";
				} else {

					let g = data_h.games[num];		
					for (let i = 0; i < g.game_url.length; i++) {
						if (g.game_url[i] !== "") {

							/*
							let newtab = "";
							if (!g.game_url[i].match(/ux\.getuploader\.com/)) {
								newtab = "target='_blank'";
							}

							if (i != 0) {
								dl = dl + " / ";
								dl = `${dl}<a href='${g.game_url[i]}' ${newtab}>ダウンロード${(i + 1)}</a>`;
							} else {
								dl = `${dl}<a href='${g.game_url[i]}' ${newtab}>ダウンロード${(g.game_url[i + 1] !== "" ? (i + 1) : "")}</a>`;
							}
							*/
							if (i != 0) {
								dl = dl + " / ";
								dl = `${dl}<a href="javascript:forum('${g.game_url[i]}', ${num})">ダウンロード${(i + 1)}</a>`;
							} else {
								dl = `${dl}<a href="javascript:forum('${g.game_url[i]}', ${num})">ダウンロード${(g.game_url[i + 1] !== "" ? (i + 1) : "")}</a>`;
							}

							
						} else {
							if (i == 0) {dl = dl + "ダウンロード(✕)"}
						}
					}
				}
				$("#dl").html(dl);
				$("#comment").html(`${esc(data_h.games[num].comment)}`);
				$("#a_com").html(data_s.games[num].a_com);
				$("#content").fadeIn(0);
			}			
		});
		

	