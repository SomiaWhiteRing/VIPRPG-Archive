let additivePath = ""
if (window.location.href.includes('/entry/'))additivePath = "../"

document.addEventListener("DOMContentLoaded", function()
{
    let headerElement = document.getElementById("HEADER");
    if (headerElement)headerElement.innerHTML = '<iframe src="' + additivePath + 'header.html"></iframe><header_spacer></header_spacer><horizontal_limiter>';
});

document.addEventListener("DOMContentLoaded", function()
{
    let headerElement2 = document.getElementById("FOOTER");
    if (headerElement2)headerElement2.innerHTML = '<spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px><spacer10px></spacer10px></horizontal_limiter><iframe class="footer" src="' + additivePath + 'footer.html"></iframe>';
});

document.addEventListener("DOMContentLoaded", function()
{
    let headerElement3 = document.getElementById("PAGENAME");
    if (headerElement3)headerElement3.innerHTML = '<h1>' + pageName + '</h1>';
});

document.addEventListener("DOMContentLoaded", function()
{
    let headerElement4 = document.getElementById("GAMENAME");
    if (headerElement4)headerElement4.innerHTML = '<h2>No.' + gameNo + " " + pageName + '</h1>';
});

document.title = "VIPRPG夏の陣2024 > "+ pageName;
