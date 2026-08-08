// Atlas Alpha 0.7 - Inventory Importer
export class InventoryImporter {
  constructor(store){ this.store = store; }
  async importItems(items){
    const report={new:0,updated:0,duplicates:0};
    for(const item of items){
      const existing=this.store.inventory.find(p=>p.name.toLowerCase()===item.name.toLowerCase());
      if(existing){
        Object.assign(existing,item);
        report.updated++;
        report.duplicates++;
      }else{
        this.store.inventory.push(item);
        report.new++;
      }
    }
    return report;
  }
}
