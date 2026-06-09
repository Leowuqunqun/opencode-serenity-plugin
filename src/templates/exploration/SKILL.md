# Skill: {{prefix}}-exploration — 探索机制

> EXC+MC 双阶段探索，发现未知领域并产出 skill 草案。

## 用途

当需要了解未知系统、发现知识缺口、或者评估一个不熟悉的领域时使用。

## 探索机制

### 第一阶段：EXC（Exploration by Classifying）

- 随机采样目标系统的多个组成部分
- 对每个样本进行分类（已知/模糊/未知）
- 输出探索报告，标记知识缺口

### 第二阶段：MC（Mining and Crystallizing）

- 选择知识缺口最深的方向
- 深度挖掘，理解细节
- 产出 skill 草案（包含 SKILL.md 骨架、参考文档列表、关键概念图）

## 使用方式

1. 加载 exploration skill
2. 设定探索范围和采样策略
3. 执行 EXC 阶段
4. 评估探索报告，确定深挖方向
5. 执行 MC 阶段
6. 产出 skill 草案
