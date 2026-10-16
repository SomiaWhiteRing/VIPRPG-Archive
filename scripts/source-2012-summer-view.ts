import * as cheerio from "cheerio";
import { readStaticLiteralArray, replaceStaticArray } from "./source-static-array";

export function rewriteSummer2012Source(text: string, file: string, reference: (value: string) => string, missingScreenshots: number[] = []) {
  if (file === "data.js") {
    const data = readStaticLiteralArray(text, "DATA");
    for (let no = 0; no < 90; no++) {
      for (const offset of [7, 8]) {
        const $ = cheerio.load(String(data[no * 11 + offset]), {}, false);
        $("script,iframe,object,embed,form,input,button").remove();
        $("*").each((_, e) => {
          for (const attr of Object.keys(e.attribs)) if (attr.startsWith("on")) $(e).removeAttr(attr);
          for (const attr of ["src", "href"]) { const value = $(e).attr(attr); if (value) $(e).attr(attr, reference(value)); }
        });
        data[no * 11 + offset] = $.root().html() || "";
      }
    }
    data[14 * 11] = "No.14（原題記載なし）";
    return replaceStaticArray(text, "DATA", data) + `
var archiveMissingSS2012=${JSON.stringify(missingScreenshots)};
function archiveSS2012(no){return 'ss/no'+no+'.png';}
function archiveIcon2012(no){return 'icon/no'+no+([14,15,78].indexOf(Number(no))>=0?'.gif':'.png');}
function archiveFix2012(){
  document.querySelectorAll('img[src]').forEach(function(img){var parts=new URL(img.src).pathname.split('/'),name=parts.pop(),parent=parts.pop(),no=Number(name.slice(2).split('.')[0]);if(parent==='ss'&&name.indexOf('no')===0&&archiveMissingSS2012.indexOf(no)>=0){var text=document.createElement('span');text.textContent='スクリーンショット未取得（原資料の画像が空です）';img.replaceWith(text);}});
  var list=Boolean(document.getElementById('ksglist'));
  document.querySelectorAll('a[href]').forEach(function(a){
    var url=new URL(a.href),n=url.searchParams.get('no');
    if(n===null)return;
    n=Number(n);
    if(n<0||n>=90){a.replaceWith(document.createTextNode(a.textContent));return;}
    if(n!==0)return;
    var block=list?a.closest('tr'):a.closest('table');if(!block)return;
    block.querySelectorAll('a[href]').forEach(function(link){var u=new URL(link.href);if(/onedrive|jbbs/.test(u.hostname))link.replaceWith(document.createTextNode('---'));});
  });
  if(location.pathname.indexOf('sakuhin')>=0){
    var n=Number(new URL(location.href).searchParams.get('no'));
    if(n===0)document.querySelectorAll('a[href]').forEach(function(a){if(/onedrive|jbbs/.test(new URL(a.href).hostname))a.replaceWith(document.createTextNode('---'));});
  }
}
`;
  }
  if (file !== "disp.js" && !/^sakuhin_?\.html$/.test(file)) return text;
  let result = text;
  if (file === "sakuhin_.html") result = result.replace("i=no*10", "i=no*11");
  for (const extension of ["png", "gif"]) {
    result = result.replaceAll(`src=\\"ss/no",no,".${extension}\\"`, 'src=\\"",archiveSS2012(no),"\\"');
    result = result.replaceAll(`src=\\"icon/no",no,".${extension}\\"`, 'src=\\"",archiveIcon2012(no),"\\"');
  }
  if (!result.includes("archiveSS2012(no)")) throw new Error(`Unrecognized source screenshot expression: ${file}`);
  if (file === "disp.js") {
    const wrongColumn = /\} else if\(ca==4\)\{[\s\S]*?\} else if\(ca==5\)\{/;
    if (!wrongColumn.test(result)) throw new Error("Missing source streaming-column branch");
    result = result.replace(wrongColumn, '} else if(ca==4){document.write("<td>",DATA[i+5],"</td>");} else if(ca==5){');
  }
  return result + "\nif(document.readyState==='loading')document.addEventListener('DOMContentLoaded',archiveFix2012,{once:true});else archiveFix2012();\n";
}
