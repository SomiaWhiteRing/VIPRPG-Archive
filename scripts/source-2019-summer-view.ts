import * as cheerio from 'cheerio';
import ts from 'typescript';

export type Summer2019Entry = Record<string,string>;
export type Summer2019Post = Record<string,string|boolean|number>;
const sourceFile=(text:string)=>ts.createSourceFile('published-source.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);

export function decodeSummer2019Wrapper(outer:string){
  const q=cheerio.load(outer),values:string[]=[];
  q('script').each((_,e)=>{const source=sourceFile(q(e).html()||'');function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='goog.script.init'){const arg=node.arguments[0];if(!arg||!ts.isStringLiteralLike(arg))throw new Error('Apps wrapper argument is not a literal');const value=JSON.parse(arg.text);if(typeof value.userHtml!=='string')throw new Error('Apps source HTML missing');values.push(value.userHtml);}ts.forEachChild(node,visit);}visit(source);});
  if(values.length!==1)throw new Error('Ambiguous Apps wrapper');
  return values[0];
}

export function readSummer2019Data(html:string){
  const q=cheerio.load(html),found:Record<string,unknown>={};
  q('script:not([src])').each((_,e)=>{const source=sourceFile(q(e).html()||'');function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&['globalDataes','globalBoard'].includes(node.name.getText(source))){const call=node.initializer;if(!call||!ts.isCallExpression(call)||call.expression.getText(source)!=='JSON.parse'||call.arguments.length!==1||!ts.isStringLiteralLike(call.arguments[0]))throw new Error('Dataset must be a JSON.parse literal');found[node.name.getText(source)]=JSON.parse(call.arguments[0].text);}ts.forEachChild(node,visit);}visit(source);});
  if(!Array.isArray(found.globalDataes)||!Array.isArray(found.globalBoard))throw new Error('Publisher datasets missing');
  const entries=found.globalDataes as Summer2019Entry[],board=found.globalBoard as Summer2019Post[];
  if(entries.length!==52||entries.some((e,n)=>String(e.gameNo)!==String(n)))throw new Error('Published entry numbering changed');
  return{entries,board};
}

type Edit={start:number;end:number;text:string};
function rewriteClient(code:string){
  const source=sourceFile(code),edits:Edit[]=[];let images=0,submit=0,share=0,body=0;
  function visit(node:ts.Node){
    if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='getGoogleUrl'&&node.initializer){edits.push({start:node.initializer.getStart(source),end:node.initializer.end,text:'(id) => window.archiveSummerImages[id] || ""'});images++;return;}
    if(ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)){
      const call=node.expression,target=call.expression.getText(source);
      if(target==="$('#submitBtn').on") {edits.push({start:node.getStart(source),end:node.end,text:'/* Archived form: no IP lookup or remote submission. */'});submit++;return;}
      if(target==="$('#urlViewer').val") {edits.push({start:call.arguments[0].getStart(source),end:call.arguments[0].end,text:'new URL("?game="+gameNo,location.href).href'});share++;return;}
    }
    if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='body'&&node.parent&&ts.isVariableDeclarationList(node.parent)&&ts.isVariableStatement(node.parent.parent)){
      edits.push({start:node.parent.parent.getStart(source),end:node.parent.parent.getStart(source),text:'if(!ss1){image="<p data-archive-no-image>原公開データにスクリーンショットはありません。</p>";}\n'});body++;
    }
    if(ts.isCallExpression(node)&&node.expression.getText(source)==='getGoogleUrl'&&node.arguments[0]?.getText(source)==="element['icon']"){
      edits.push({start:node.arguments[0].getStart(source),end:node.arguments[0].end,text:"element['icon'] || '1D_4Xt0GvJkq9aEr6tSgLtHlFnr-uljC3'"});
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
  let text=code;for(const e of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,e.start)+e.text+text.slice(e.end);
  return {text,images,submit,share,body};
}

export function createSummer2019Replay(html:string,imageMap:Record<string,string>){
  const q=cheerio.load(html),counts={images:0,submit:0,share:0,body:0};let clients=0;
  q('script:not([src])').each((_,e)=>{const result=rewriteClient(q(e).html()||'');q(e).text(result.text);for(const key of ['images','submit','share','body']as const)counts[key]+=result[key];clients++;});
  if(clients!==4||Object.values(counts).some(n=>n!==1))throw new Error('Published client script structure changed');
  q('script[src],link[rel=stylesheet]').removeAttr('integrity crossorigin');
  q('form').attr('onsubmit','return false').find('input,textarea,select,button').attr('disabled','disabled');
  const notice='<p data-archive-notice style="padding:8px;border:1px solid #aab7c4;background:#f1f5f8">保存資料：作品・掲示板は2025-10-11の公開応答を再生しています。原サービスは実行基盤の廃止で停止しており、投稿・ダウンロード計数の送信は行いません。再読み込みは保存済みの投稿を再表示します。</p>';
  q('body').prepend(notice);
  const images=JSON.stringify(imageMap).replace(/</g,'\\u003c');
  q('head').append(`<script data-archive-runtime>
window.archiveSummerImages=${images};
window.google={script:{url:{getLocation:function(callback){var p=new URL(location.href).searchParams;queueMicrotask(function(){callback({parameter:{game:p.get('game')||'0',list:p.get('list')}});});}},run:{withSuccessHandler:function(success){return{updateBoardDataes:function(){if(success)success(globalBoard);},downloadCount:function(){},writeBoard:function(){throw new Error('Archived source is read-only');}};}}}};
document.addEventListener('submit',function(e){e.preventDefault();});
</script>`);
  return q.html();
}
