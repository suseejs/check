// cSpell:disable
import path from "node:path";
import ts from "typescript";

interface DepsFile {
  file: string;
  content: string;
}

const jsesm_exts = [".js", ".mjs"];
const jscjs_exts = [".cjs"];
const tsesm_exts = [".ts", ".mts"];
const tscjs_exts = [".cts"];
const jsx_exts = [".jsx", ".tsx"];
const all_exts = [
  ...jscjs_exts,
  ...jsesm_exts,
  ...tscjs_exts,
  ...tsesm_exts,
  ...jsx_exts,
];

/**
 * Check types of given files and exit process if any errors are found.
 * @param deps List of files to check, where each file is an object with
 *          `file` and `content` properties.
 * @param compilerOptions TypeScript compiler options.
 * @returns True if no errors are found, false otherwise.
 */
function checkTypes(deps: DepsFile[], compilerOptions: ts.CompilerOptions) {
  if (!compilerOptions.noCheck) {
    console.time("types checked");
    const filePaths = deps.map((i) => i.file);
    let _err = false;
    // Create program
    const program = ts.createProgram(filePaths, compilerOptions);
    // Check each file individually for immediate feedback
    for (const filePath of filePaths) {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) {
        console.error(
          `File not found: ${path.relative(process.cwd(), filePath)}`,
        );
        process.exit(1);
      }

      const diagnostics = [
        ...program.getSyntacticDiagnostics(sourceFile),
        ...program.getSemanticDiagnostics(sourceFile),
        ...program.getDeclarationDiagnostics(sourceFile),
      ];

      if (diagnostics.length > 0) {
        const formatHost: ts.FormatDiagnosticsHost = {
          getCurrentDirectory: () => process.cwd(),
          getCanonicalFileName: (fileName) => fileName,
          getNewLine: () => ts.sys.newLine,
        };
        console.error(
          ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost),
        );
        _err = true;
      }
    }
    if (_err) {
      process.exit(1);
    } else {
      console.timeEnd("types checked");
      return true;
    }
  }
}

function checkJSX(deps: DepsFile[]) {
  const exts = deps.map((dep) => {
    return path.extname(dep.file);
  });
  const jsxSet = new Set(jsx_exts);
  return exts.every((i) => jsxSet.has(i));
}

/**
 * Check the file extensions of given dependencies.
 * @param deps List of files to check, where each file is an object with
 *          `file` and `content` properties.
 * @returns True if no unsupported file extensions are found, false otherwise.
 * @throws If unsupported file extensions are found, the function will throw an error and exit the process.
 */
function checkExtGroup(deps: DepsFile[]) {
  const exts = deps.map((dep) => {
    return path.extname(dep.file);
  });
  const jsesmSet = new Set(jsesm_exts);
  const jscjsSet = new Set(jscjs_exts);
  const tsesmSet = new Set(tsesm_exts);
  const tscjsSet = new Set(tscjs_exts);
  const allSet = new Set(all_exts);
  const isCjs =
    exts.every((i) => jscjsSet.has(i)) || exts.every((i) => tscjsSet.has(i));
  const isJs = exts.every((i) => jsesmSet.has(i));
  const isTs = exts.every((i) => tsesmSet.has(i));
  const isBoth = isJs && isTs;
  const isNone = !exts.every((i) => allSet.has(i));
  if (isNone) {
    console.warn(
      "Bundler detects none Javascript or Typescript extensions in the dependencies tree.",
    );
    process.exit(1);
  }
  if (isCjs) {
    console.warn(
      "The package detects commonjs extensions (.cjd or .cts) in the dependencies tree, which is currently unsupported.",
    );
    process.exit(1);
  }
  if (isBoth) {
    console.warn(
      "The package detects both Javascript or Typescript extensions in the dependencies tree, currently unsupported.",
    );
    process.exit(1);
  }

  return true;
}

/**
 * Check the module format of all the given files.
 * @param deps List of files to check, where each file is an object with
 *          `file` and `content` properties.
 * @returns True if the function finishes without errors, false otherwise.
 */
function checkModuleFormat(deps: DepsFile[]) {
  let _esmCount = 0;
  let cjsCount = 0;
  let unknowCount = 0;
  for (const dep of deps) {
    try {
      // Create a TypeScript source file
      const sourceFile = ts.createSourceFile(
        dep.file,
        dep.content,
        ts.ScriptTarget.Latest,
        true,
      );

      let hasESMImports = false;
      let hasCommonJS = false;
      // Walk through the AST to detect module syntax
      function walk(node: ts.Node) {
        // Check for ESM import/export syntax
        if (
          ts.isImportDeclaration(node) ||
          ts.isImportEqualsDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          ts.isExportSpecifier(node) ||
          ts.isExportAssignment(node)
        ) {
          hasESMImports = true;
        }

        // Check for export modifier on declarations
        if (
          (ts.isVariableStatement(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isClassDeclaration(node)) &&
          node.modifiers?.some(
            (mod) => mod.kind === ts.SyntaxKind.ExportKeyword,
          )
        ) {
          hasESMImports = true;
        }

        // Check for CommonJS require/exports
        if (ts.isCallExpression(node)) {
          if (
            ts.isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            node.arguments.length > 0
          ) {
            hasCommonJS = true;
          }
        }

        // Check for module.exports or exports.xxx
        if (ts.isPropertyAccessExpression(node)) {
          const text = node.getText(sourceFile);
          if (
            text.startsWith("module.exports") ||
            text.startsWith("exports.")
          ) {
            hasCommonJS = true;
          }
        }

        // Continue walking the AST
        ts.forEachChild(node, walk);
      }
      walk(sourceFile);

      // Determine the module format based on what we found
      if (hasESMImports && !hasCommonJS) {
        _esmCount++;
      } else if (hasCommonJS && !hasESMImports) {
        cjsCount++;
      } else if (hasESMImports && hasCommonJS) {
        // Mixed - probably ESM with dynamic imports or similar
        _esmCount++;
      }
    } catch (error) {
      console.error(
        `Error checking module format for ${dep.file} : \n ${error}`,
      );
      unknowCount++;
    }
  } // loop
  if (unknowCount) {
    console.warn(
      "Unknown error when checking module types in the dependencies tree.",
    );
    process.exit(1);
  }
  if (cjsCount) {
    console.warn(
      "The package detects CommonJs format  in the dependencies tree, currently unsupported.",
    );
    process.exit(1);
  }
  return true;
}

/**
 * Check if all files in the given list have the same file extension and
 * the same module format.
 * @param deps List of files to check, where each file is an object with
 *          `file` and `content` properties.
 * @returns True if all files have the same file extension and module format,
 *          false otherwise.
 */
function fileExtensionAndFormat(deps: DepsFile[]) {
  console.time("checked extension and module");
  const ce = checkExtGroup(deps);
  const cm = checkModuleFormat(deps);
  console.timeEnd("checked extension and module");
  return ce && cm;
}

const check = { checkTypes, fileExtensionAndFormat, checkJSX };

export default check;
