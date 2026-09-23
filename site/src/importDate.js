const DATE_FIELD_PATTERN=/(?:^|[\s_-])(date|day|period|дата|день|период)(?:$|[\s_-])|created|scheduled|service|выполн|создан/i;

const validLocalDate=(year,month,day)=>{
  const date=new Date(year,month-1,day);
  return date.getFullYear()===year&&date.getMonth()===month-1&&date.getDate()===day?date:null;
};

export function parseImportedDate(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return validLocalDate(value.getFullYear(),value.getMonth()+1,value.getDate());
  const text=String(value??'').trim();
  if(!text)return null;
  let match=text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if(match)return validLocalDate(Number(match[1]),Number(match[2]),Number(match[3]));
  match=text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\D|$)/);
  if(match)return validLocalDate(Number(match[3]),Number(match[2]),Number(match[1]));
  if(/^\d{5}(?:\.\d+)?$/.test(text)){
    const serial=Number(text);
    if(serial>=20000&&serial<=80000){
      const utc=new Date(Date.UTC(1899,11,30)+Math.floor(serial)*86400000);
      return validLocalDate(utc.getUTCFullYear(),utc.getUTCMonth()+1,utc.getUTCDate());
    }
  }
  // Date.parse treats short planning values such as durations ("45") and
  // time-only strings ("09:00") as dates in 1950/2001. They are not dates.
  if(!/\d{4}|[a-zа-яё]{3,}/iu.test(text))return null;
  const timestamp=Date.parse(text);
  if(Number.isNaN(timestamp))return null;
  const parsed=new Date(timestamp);
  return validLocalDate(parsed.getFullYear(),parsed.getMonth()+1,parsed.getDate());
}

const orderDateValues=order=>{
  const direct=[order?.serviceDate,order?.workDate,order?.scheduledDate,order?.date,order?.createdAt];
  const fromRecord=record=>Object.entries(record||{}).filter(([key])=>DATE_FIELD_PATTERN.test(String(key))).map(([,value])=>value);
  return [...direct,...fromRecord(order?.sourceData),...fromRecord(order?.customFields)];
};

export function resolveImportedDate(orders=[],today=new Date()){
  const limit=new Date(today.getFullYear(),today.getMonth(),today.getDate()).getTime();
  const counts=new Map();
  orders.forEach(order=>{
    const date=orderDateValues(order).map(parseImportedDate).find(Boolean);
    if(!date||date.getTime()>limit)return;
    const key=date.getTime();
    counts.set(key,(counts.get(key)||0)+1);
  });
  if(!counts.size)return null;
  const [timestamp]=[...counts].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0];
  return new Date(timestamp);
}
