import ts, { JsxFragment } from 'typescript';
import type {
  Diagnostic,
  JsxElement,
  JsxOpeningElement,
  Node,
  default as TS,
  Type,
  TypeChecker
} from 'typescript/lib/tsserverlibrary';
import * as Errors from './errors';

const UPPERCASE = /[A-Z]/;
const ESCAPE_HTML_REGEX = /^(\w+\.)?escapeHtml/i;

/** If the node is a JSX element or fragment */
export function isJsx(ts: typeof TS, node: TS.Node): node is JsxElement | JsxFragment {
  return ts.isJsxElement(node) || ts.isJsxFragment(node);
}

export function recursiveDiagnoseJsxElements(
  ts: typeof TS,
  node: Node,
  typeChecker: TypeChecker,
  original: Diagnostic[]
) {
  ts.forEachChild(node, function loopSourceNodes(node) {
    // Recurse through children first
    ts.forEachChild(node, loopSourceNodes);

    // Adds children to the array
    if (isJsx(ts, node)) {
      // Diagnose the node
      diagnoseJsxElement(ts, node, typeChecker, original);
    }
  });
}

function diagnostic(
  node: ts.Node,
  error: keyof typeof Errors,
  category: keyof typeof TS.DiagnosticCategory
): ts.Diagnostic {
  console.trace('diagnostic', node.getText(), error, category);

  return {
    category: ts.DiagnosticCategory[category],
    messageText: Errors[error].message,
    code: Errors[error].code,
    file: node.getSourceFile(),
    length: node.getWidth(),
    start: node.getStart()
  };
}

export function diagnoseJsxElement(
  ts: typeof TS,
  node: JsxElement | JsxFragment,
  typeChecker: TypeChecker,
  diagnostics: Diagnostic[]
): void {
  const file = node.getSourceFile();

  // Validations that does not applies to fragments
  if (ts.isJsxElement(node)) {
    // Script tags should be ignored
    if (node.openingElement.tagName.getText() === 'script') {
      return;
    }

    const safeAttribute = getSafeAttribute(node.openingElement);

    // Safe mode warnings
    if (safeAttribute) {
      if (
        // Empty element
        node.children.length === 0 ||
        // Only text elements
        (node.children.length === 1 && node.children[0]!.kind === ts.SyntaxKind.JsxText)
      ) {
        diagnostics.push(diagnostic(safeAttribute, 'UnusedSafe', 'Warning'));
        return;
      }

      for (const exp of node.children) {
        if (
          // JSX Element inside safe
          ts.isJsxElement(exp) ||
          // Element is using safe with escapeHtml
          (ts.isJsxExpression(exp) && exp.expression?.getText().match(ESCAPE_HTML_REGEX))
        ) {
          diagnostics.push(diagnostic(safeAttribute, 'DoubleEscape', 'Error'));
          continue;
        }

        // Warn on unnecessary safe attributes
        if (
          ts.isJsxExpression(exp) &&
          // has inner expression
          exp.expression &&
          // is expression safe
          isSafeAttribute(
            ts,
            typeChecker.getTypeAtLocation(exp.expression!),
            exp.expression!,
            typeChecker
          ) &&
          // does not starts with unsafe
          !exp.expression.getText().startsWith('unsafe') &&
          // Avoids double warnings
          !diagnostics.some((d) => d.start === safeAttribute.pos + 1 && d.file === file)
        ) {
          diagnostics.push(diagnostic(safeAttribute, 'UnusedSafe', 'Warning'));
          continue;
        }
      }

      return;
    }
  }

  // Look for expressions
  for (const exp of node.children) {
    if (!ts.isJsxExpression(exp)) {
      continue;
    }

    // Should always have an expression
    if (!exp.expression) {
      continue;
    }

    diagnoseExpression(
      ts,
      exp.expression,
      typeChecker,
      diagnostics,
      ts.isJsxElement(node) && !!node.openingElement.tagName.getText().match(UPPERCASE)
    );
  }

  return;
}

function diagnoseExpression(
  ts: typeof TS,
  node: ts.Expression,
  typeChecker: TypeChecker,
  diagnostics: Diagnostic[],
  isComponent: boolean
): void {
  // Unwrap parenthesis
  if (ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }

  // Ignores JSX elements as they are already diagnosed by the loopChildNodes
  if (isJsx(ts, node)) {
    return;
  }

  // Checks both sides
  if (ts.isBinaryExpression(node)) {
    // Ignores operations which results in a boolean
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.InstanceOfKeyword:
      case ts.SyntaxKind.InKeyword:
        return;
    }

    // We do not need to evaluate the left side of the expression
    // as its value will only be used if its falsy, which cannot have
    // XSS content
    diagnoseExpression(ts, node.right, typeChecker, diagnostics, isComponent);

    return;
  }

  // Checks the inner expression
  if (ts.isConditionalExpression(node)) {
    diagnoseExpression(ts, node.whenTrue, typeChecker, diagnostics, isComponent);
    diagnoseExpression(ts, node.whenFalse, typeChecker, diagnostics, isComponent);
    // ignore node.condition because its value will never be rendered
    return;
  }

  const type = typeChecker.getTypeAtLocation(node);

  // Safe can be ignored
  if (isSafeAttribute(ts, type, node, typeChecker)) {
    return;
  }

  // Anything other than a identifier should be diagnosed
  if (!ts.isIdentifier(node)) {
    let hadJsx = false;

    for (const tag of node.getChildren()) {
      if (!isJsx(ts, tag)) {
        continue;
      }

      hadJsx = true;

      diagnoseJsxElement(
        ts,
        tag as JsxElement | ts.JsxFragment,
        typeChecker,
        diagnostics
      );
    }

    // If root JSX element found inside array, diagnose it,
    // otherwise let the diagnostic pass
    if (hadJsx) {
      return;
    }
  }

  // Switch between component and element xss errors
  if (isComponent || ts.isJsxFragment(node)) {
    diagnostics.push(diagnostic(node, 'ComponentXss', 'Error'));
  } else {
    diagnostics.push(diagnostic(node, 'Xss', 'Error'));
  }
}

export function isSafeAttribute(
  ts: typeof TS,
  type: Type | undefined,
  expression: Node,
  checker: TypeChecker
): boolean {
  // Nothing to do if type cannot be resolved
  if (!type) {
    return true;
  }

  // Any type is never safe
  if (type.flags & ts.TypeFlags.Any) {
    return false;
  }

  if (type.aliasSymbol) {
    // Allows JSX.Element
    if (
      type.aliasSymbol.escapedName === 'Element' &&
      // @ts-expect-error - Fast way of checking
      type.aliasSymbol.parent?.escapedName === 'JSX' &&
      // Only allows in .map() or other method calls
      ts.isCallExpression(expression)
    ) {
      return true;
    }

    // Allows Html.Children
    if (
      type.aliasSymbol.escapedName === 'Children' &&
      // @ts-expect-error - Fast way of checking
      type.aliasSymbol.parent?.escapedName === 'Html'
    ) {
      return true;
    }
  }

  // Union types should be checked recursively
  if (type.isUnion()) {
    return (type as TS.UnionType).types.every((t) =>
      isSafeAttribute(ts, t, expression, checker)
    );
  }

  // For Array or Promise, we check the type of the first generic
  if (checker.isArrayType(type) || type.symbol?.escapedName === 'Promise') {
    return isSafeAttribute(
      ts,
      (type as any).resolvedTypeArguments?.[0],
      expression,
      checker
    );
  }

  // We allow literal string types here, as if they have XSS content,
  // the user has explicitly written it
  if (
    // Non string types cannot have XSS values
    !(type.flags & ts.TypeFlags.String) &&
    // Objects may have toString() overridden
    !(type.flags & ts.TypeFlags.Object)
  ) {
    return true;
  }

  const text = expression.getText();

  if (
    // Variables starting with safe are suppressed
    text.startsWith('safe') ||
    // Starts with a call to a escapeHtml function name
    text.match(ESCAPE_HTML_REGEX)
  ) {
    return true;
  }

  return false;
}

export function getSafeAttribute(element: JsxOpeningElement) {
  for (const attribute of element.attributes.properties) {
    if (attribute.getText() === 'safe') {
      return attribute;
    }
  }

  return undefined;
}

export function proxyObject<T extends object>(obj: T): T {
  const proxy: T = Object.create(null);

  for (let k of Object.keys(obj) as Array<keyof T>) {
    const x = obj[k]!;
    // @ts-expect-error - JS runtime trickery which is tricky to type tersely
    proxy[k] = (...args: Array<{}>) => x.apply(obj, args);
  }

  return proxy;
}
