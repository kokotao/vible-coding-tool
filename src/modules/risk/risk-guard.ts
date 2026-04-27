/**
 * @description 评估命令文本风险等级，输出高风险关键词命中结果
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 09:26
 */
const DEFAULT_HIGH_RISK_KEYWORDS = ["删除", "重置", "清库", "覆盖发布", "强制推送", "prod", "main", "master"];

export function evaluateRisk(content: string, customKeywords: string[] = []) {
  const normalized = content.toLowerCase();
  const keywords = [...new Set([...DEFAULT_HIGH_RISK_KEYWORDS, ...customKeywords])]
    .map((keyword) => keyword.trim())
    .filter(Boolean);

  const matched = keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
  const level = matched.length > 0 ? "high" : "low";

  return {
    level,
    keywords: matched
  };
}
