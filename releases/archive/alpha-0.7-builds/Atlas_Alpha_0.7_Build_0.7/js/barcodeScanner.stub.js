// Atlas Alpha 0.7
// Placeholder for BarcodeDetector / ZXing integration.
export async function scanBarcode(){
  if('BarcodeDetector' in window){
    return {supported:true,message:'Ready for BarcodeDetector integration'};
  }
  return {supported:false,message:'Use ZXing fallback in next build'};
}
