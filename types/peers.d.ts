// 供 tsc 类型检查用的 peer 依赖桩（CI 里不安装这两个包 —— 它们很重，
// @earendil-works/pi-coding-agent 解包后 400MB+，而本仓库的原则是“零运行时依赖”。
// 真正用到 peer 的只有入口 index.ts 的一小层胶水；lib/*.ts 与 tests/ 只用 node: 标准库，
// 因此这里只需要把这两个模块名“占位”成宽松类型，让 tsc 能把整个仓库过一遍。
//
// 本地开发机 node_modules/ 里有真包（软链进全局 pi 安装），但这里的环境声明模块会优先生效 ——
// 本地与 CI 用的是同一份桩，行为一致。
declare module "typebox" {
  // Type.Object(...) / Type.String(...) 等构建器的链条太深，桩里不复制；用 any 占位。
  export const Type: any;
}

declare module "@earendil-works/pi-coding-agent" {
  // 入口只用这三个方法注册工具/命令/事件（registerTool 用 execute、registerCommand 用 handler，
  // 与 pi 真包一致）。给它们的回调一个显式的 `(...args: any[]) => any` 签名，好处是箭头函数里的
  // 参数被**上下文**类型标成 any，而不是隐式 any —— 于是 strict 下无需在入口里堆 @ts-ignore。
  // 其余成员（pi.xxx / ctx.xxx）走索引签名，形态由真包决定，桩不复制。
  export interface ExtensionAPI {
    registerTool(def: { name: string; label?: string; description?: string; parameters?: any; execute?: (...args: any[]) => any; [k: string]: any }): void;
    registerCommand(name: string, def: { handler?: (...args: any[]) => any; [k: string]: any }): void;
    on(event: string, handler: (...args: any[]) => any): void;
    [key: string]: any;
  }
}
