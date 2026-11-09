import express, { type Express, type Request, type Response } from "express";
import { Scrape } from "../Scrape.js";

const app: Express = express();

const port = 3000;





//then you add async before req res
app.get('/api/events', (req: Request, res: Response) => {
  

    //could do this too const results = await Scrape


const reuslts = Scrape().then((arr) => {
    // `return` keyword added
    res.json({
        message:"Riftbound Events API",
        status:"success",
        events: arr 
        //events scrape

    })
  })
 




});

app.listen(port, () => {
  console.log(`listening  ${port}`);
});
