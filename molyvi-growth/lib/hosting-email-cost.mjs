// Price snapshot dated 2026-10-14. Estimates only; no provider or billing calls.
export function estimateHostingEmailCost(plan,usage={}){
  const p=plan.hosting,b=plan.backup,e=plan.email,initial=plan.initialUsageAssumptions;
  const defaults={diskGB:p.diskGB,outboundGB:initial.outboundGBMonthIncludingBackups,backupGBMonth:initial.backupGBMonthIncludingVersions,
    classARequests:initial.backupClassARequests,classBRequests:initial.backupClassBRequests,customDomains:initial.customDomainsOnRender,
    buildMinutes:initial.buildMinutesPerMonth,emails:initial.emailsPerMonth,peakDailyEmails:initial.peakEmailsPerDay,paidEmail:false,paidWorkspace:false,paidInbox:false,standardCompute:false};
  const allowed=Object.keys(defaults);if(Object.keys(usage).some(k=>!allowed.includes(k)))throw Error('INVALID_COST_INPUT');
  const input={...defaults,...usage};
  for(const key of ['diskGB','outboundGB','backupGBMonth','classARequests','classBRequests','customDomains','buildMinutes','emails','peakDailyEmails'])if(!Number.isFinite(input[key])||input[key]<0)throw Error('INVALID_COST_INPUT');
  for(const key of ['paidEmail','paidWorkspace','paidInbox','standardCompute'])if(typeof input[key]!=='boolean')throw Error('INVALID_COST_INPUT');
  const round=n=>Math.round(n*10000)/10000;
  const parts={workspace:input.paidWorkspace?p.paidWorkspaceUpgradeUsd:p.workspaceMonthlyUsd,compute:input.standardCompute?p.standardInstanceMonthlyUsd:p.instanceMonthlyUsd,
    disk:input.diskGB*p.diskUsdPerGBMonth,
    bandwidth:Math.max(0,input.outboundGB-(input.paidWorkspace?25:p.includedOutboundGB))*p.extraOutboundUsdPerGB,
    customDomains:Math.max(0,input.customDomains-(input.paidWorkspace?15:p.includedCustomDomains))*p.extraCustomDomainUsdPerMonth,
    builds:Math.ceil(Math.max(0,input.buildMinutes-(input.paidWorkspace?1000:p.includedBuildMinutes))/1000)*p.extraBuildMinutesUsdPer1000,
    email:input.paidEmail?e.upgradeMonthlyUsd:e.monthlyUsd,
    backupStorage:Math.max(0,Math.ceil(input.backupGBMonth)-b.includedGBMonth)*b.storageUsdPerGBMonth,
    backupWrites:Math.ceil(Math.max(0,input.classARequests-b.includedClassARequests)/1_000_000)*b.classAUsdPerMillion,
    backupReads:Math.ceil(Math.max(0,input.classBRequests-b.includedClassBRequests)/1_000_000)*b.classBUsdPerMillion};
  const emailFits=input.paidEmail?input.emails<=e.upgradeMonthlyEmails:input.emails<=e.monthlyEmails&&input.peakDailyEmails<=e.dailyEmails;
  return {status:emailFits?'ESTIMATE_WITHIN_EMAIL_ALLOWANCE':'EMAIL_PLAN_REVIEW_REQUIRED',activationApproved:false,
    currency:'USD',monthlyUsd:round(Object.values(parts).reduce((sum,n)=>sum+n,0)),annualUsd:round(Object.values(parts).reduce((sum,n)=>sum+n,0)*12),
    parts:Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,round(v)])),additionalMonthlyEur:input.paidInbox?plan.inbox.paidFallbackMonthlyEur:0,
    taxesIncluded:false,measuredProductionUsage:false,assumptions:input};
}
