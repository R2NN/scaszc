import contract from './orderSemantics.json' with { type: 'json' };

const normalize = value => String(value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
const matches = (pattern, value) => new RegExp(pattern, 'i').test(value);

/** Resolve duration kind, required qualification and queue priority from one shared contract. */
export function orderSemantics(order) {
  const source = order?.sourceData || {};
  const group = normalize(order?.workType || source.bk_type || order?.skill);
  const subtype = normalize(order?.serviceType || source.hd_type);
  const skill = normalize(order?.skill || source.required_skill);
  const rawPriority = normalize(order?.priority ?? source.priority);
  const emergencyPriority = contract.emergencyPriorities.includes(rawPriority);
  const information = (matches(contract.globalPattern, group) && matches(contract.informationPattern, subtype)) || matches(contract.informationPattern, group);
  const rule = information ? null : emergencyPriority || matches(contract.globalPattern, group)
    ? contract.kinds[0] : contract.kinds.find(item => matches(item.pattern, `${group} ${skill}`));
  const kind = information ? 'information' : rule?.kind || null;
  const reviewedSkill = String(source.required_skill || '').toUpperCase();
  const preserveReviewedSkill = kind === 'equipment' && group === normalize(source.bk_type)
    && skill === normalize(reviewedSkill) && contract.reviewedEquipmentSkills.includes(reviewedSkill);
  const priority = kind === 'emergency' || emergencyPriority || contract.urgentPriorities.includes(rawPriority) ? 'URGENT'
    : contract.normalPriorities.includes(rawPriority) ? 'NORMAL' : null;
  return { kind, requiredSkill: information ? contract.informationSkill : preserveReviewedSkill ? reviewedSkill : rule?.skill || null, priority, skillLabel: information ? contract.kinds[0].label : rule?.label || null };
}
