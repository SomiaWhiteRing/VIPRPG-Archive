

		function hl (obj) {
			$(`#${obj}`).css("background-color", "rgba(255, 255, 230, 0.9)");
			$(`#${obj}`).css("border", "1px solid rgba(0, 0, 0, 0.5)");
		}
		function hlo (obj) {
			$(`#${obj}`).css("background-color", "rgba(255, 255, 255, 0)");
			$(`#${obj}`).css("border", "1px solid rgba(0, 0, 0, 0)");
		}
		function entry() {

			if (adblock) {
				parent.frame2.location.href = "../ab.html"

			} else {

				$("#game").hide(0)
				$.ajax({
					type : 'GET',
					url : 'https://viprpg-gw2020.herokuapp.com/ping',
					timeout : 5000,
					async : false,
					success: function() {
						parent.frame2.location.href = "https://viprpg-gw2020.herokuapp.com/";
					},
					error: function(XMLHttpRequest, textStatus, errorThrown) {
						
						parent.frame2.location.href = "../entryFail.html"
						
					}
				});
			}
		}

		function red(p) {
			if (typeof p === "string") {
				parent.location.href = p;
			} else {
				parent.location.href = `./?page=${p}`;
			}
		}

		function link(p) {
			if (p > 5 || p < 0) {
				p = 0;
			}
			parent.frame2.location.href = [
				"./top.html",
				"./about.html",
				"https://jbbs.shitaraba.net/game/60946/",
				"https://jbbs.shitaraba.net/bbs/read.cgi/game/60946/1587008069/l1000",
				"./update.html",
				"./past.html"
			][p];
		}

		let bn = 0;
		const bnum = 3;

		function reroll() {
			bn = (bn + Math.floor(Math.random() * (bnum - 1)) + 1) % bnum;
			$("#banner").attr("src", `/img/gw2020_${bn + 1}.png`);	
		}

		$( document ).ready(function() {

			bn = Math.floor(Math.random() * bnum);
			$("#banner").attr("src", `/img/gw2020_${bn + 1}.png`);	

			let pg = parent.location.search.match(/page\=\d/);
			let num = location.search.match(/id\=\d+/);
			if (pg && !num) {

				link(pg = pg[0].match(/\d/)[0]);
			} else {
				
				if (num) {
					num = Number(num[0].match(/\d+/));

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

					let f = "";
					let siz = "80px"

					if (location.search.match(/forum\=true/)) {
						f = `<div style="margin:0.3rem"></div>
						<a href="javascript:red('../?id=${num}')"><span class="btn3" onmouseover="hl('c10')" onmouseout="hlo('c10')" id="c10">作品詳細ページへ戻る</span></a>`;
						siz = "114px";
					}

					$("#game").attr("class", "fw");
					$("#game").css("height", siz)
					$("#game").html(`
						<div style="margin:0.6rem"></div>
						<center><span class="box1"><b>表示中：No.${num}</b></span></center>
						<div style="margin:0.5rem"></div>
						${(num == 0 ? 
							`<span class="btn_d">◀前の作品へ</span>`
							 : 
							`<a href="javascript:red('../?id=${num - 1}')"><span class="btn2" onmouseover="hl('c8')" onmouseout="hlo('c8')" id="c8">◀前の作品へ</span></a>`
						)}
						${(num == data_s.games.length ? 
							`<span class="btn_d">次の作品へ▶</span>`
							 : 
							`<a href="javascript:red('../?id=${num + 1}')"><span class="btn2" onmouseover="hl('c9')" onmouseout="hlo('c9')" id="c9">次の作品へ▶</span></a>`
						)}
						<center>${f}</center>
					`);
				}
			}
		});

	