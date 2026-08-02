export class ImportHistory{
 constructor(){this.entries=[];}
 add(entry){this.entries.unshift({...entry,date:new Date().toISOString()});}
 all(){return this.entries;}
}
