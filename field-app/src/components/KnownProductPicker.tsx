import {useEffect,useState} from 'react';
import {fetchProductCatalog} from '../lib/api';
export function KnownProductPicker({onSelect}:{onSelect:(manufacturer:string,model:string)=>void}){
 const [products,setProducts]=useState<{manufacturer:string;model_number:string}[]>([]);
 const [unavailable,setUnavailable]=useState(false);
 useEffect(()=>{let active=true;fetchProductCatalog().then(r=>{if(active)setProducts(r.products);}).catch(()=>{if(active)setUnavailable(true);});return()=>{active=false;};},[]);
 return <div className="field"><label htmlFor="known-product">Select a known product</label>
 <select id="known-product" defaultValue="" onChange={e=>{if(e.target.value==='')return;const p=products[Number(e.target.value)];if(p)onSelect(p.manufacturer,p.model_number);}}>
 <option value="">Select a catalog product or enter it below</option>
 {products.map((p,i)=><option key={p.manufacturer+':'+p.model_number} value={i}>{p.manufacturer} {p.model_number}</option>)}
 </select><p>{unavailable?'Catalog unavailable. Enter the manufacturer and model below.':'If your product is not listed, enter its manufacturer and model below.'}</p></div>;
}
