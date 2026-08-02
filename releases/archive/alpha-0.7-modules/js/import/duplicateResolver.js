// Duplicate Resolver
export function findDuplicates(items){
  const seen=new Map(),dups=[];
  for(const i of items){
    const key=i.name.trim().toLowerCase();
    if(seen.has(key)) dups.push({existing:seen.get(key),duplicate:i});
    else seen.set(key,i);
  }
  return dups;
}
