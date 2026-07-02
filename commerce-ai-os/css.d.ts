// TypeScript 6 (TS2882) requires an ambient declaration for side-effect imports
// of non-code modules like `import "./globals.css"`. Earlier TS tolerated these
// implicitly; the actual CSS bundling is still handled by Next/webpack, this only
// satisfies the type checker.
declare module "*.css";
