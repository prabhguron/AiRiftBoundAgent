

export async function Scrape() {
    

const response = await fetch(
  'https://production-sfo.browserless.io/scrape?token=2VYHYeiqX6wyIoF50e15da5742708e18c9da66afb4d231721',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://playriftbound.com/en-US/events?q=Surrey%2C+BC%2C+Canada&lat=49.191346599999996&lng=-122.84901249999999&types=NEXUS_NIGHT',
elements: [{ selector: 'a[href^="/en-US/events/"]:not([href="/en-US/events/"])' }]    })
  }
);
const data = await response.json();

let objEventArr = []

const events = data.data[0].results;
for (let i = 0; i < events.length; i++) {
    
   
    const  arr = events[i].text.split("\n")


let obj = {
    "Month": arr[0],
    "Day": Number(arr[1]),
    "WeekTime": arr[2],
    "Title": arr[3],
    "Type": arr[4],

    "Price": arr[5] === "FREE"
        ? 0
        : Number(arr[5].split("$")[1]),

    "Players": arr[6] === "FULL"
        ? null
        : Number(arr[6].split("/")[0]),

    "Capacity": arr[6] === "FULL"
        ? null
        : Number(arr[6].split("/")[1]),

    "IsFull": arr[6] === "FULL",

    "Store": arr[8]?.split(" • ")[0] ?? "",
    "Distance": arr[8]?.split(" • ")[1] ?? "",
    "Location": arr[8]?.split(" • ")[2] ?? "",

    "EventURL": new URL(
        events[i].attributes.find(attr => attr.name === "href").value,
        "https://playriftbound.com"
    ).href
};

objEventArr.push(obj)
}
return (objEventArr)

}


    











