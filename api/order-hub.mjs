import {createVercelDemoHandler} from '../server/vercel-demo.mjs';

let handler;
export default async function orderHub(req,res){
  handler??=createVercelDemoHandler();
  await handler(req,res);
}
