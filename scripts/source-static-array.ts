import ts from "typescript";

// Read literals with a parser; never execute scripts downloaded from an archived site.
export function readStaticLiteralArray(text: string, variable: string): Array<string | number> {
  const source = ts.createSourceFile("source.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === variable) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  function literal(node: ts.Expression): unknown {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => literal(element as ts.Expression));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left), right = literal(node.right);
      if (typeof left === "string" && typeof right === "string") return left + right;
    }
    throw new Error(`Unsupported static expression: ${ts.SyntaxKind[node.kind]}`);
  }
  if (!initializer) throw new Error(`Missing source array: ${variable}`);
  const values = literal(initializer);
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" && typeof value !== "number")) throw new Error("Expected a flat literal array");
  return values as Array<string | number>;
}

export function readStaticStringArray(text: string, variable: string): string[] {
  const values = readStaticLiteralArray(text, variable);
  if (values.some((value) => typeof value !== "string")) throw new Error("Expected a flat string array");
  return values as string[];
}

export function replaceStaticArray(text: string, variable: string, values: Array<string | number>): string {
  const source = ts.createSourceFile("source.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === variable) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!initializer) throw new Error(`Missing source array: ${variable}`);
  return text.slice(0, initializer.getStart(source)) + JSON.stringify(values) + text.slice(initializer.end);
}
