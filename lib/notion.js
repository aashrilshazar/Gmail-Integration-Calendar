import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

export async function searchMeetings(companyName) {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: "Meeting Name",
        title: { contains: companyName },
      },
      sorts: [{ property: "Date of Meeting", direction: "descending" }],
    });
    return response.results.map(page => ({
      id: page.id,
      name: extractTitle(page.properties["Meeting Name"]),
      date: page.properties["Date of Meeting"]?.date?.start || null,
      category: extractSelect(page.properties["Category"]),
      summary: extractRichText(page.properties["summary"]),
      tasks: extractRichText(page.properties["Tasks"]),
      createdBy: extractCreatedBy(page.properties["Created By"]),
    }));
  } catch (err) {
    console.error("Notion search error:", err.message);
    return [];
  }
}

function extractTitle(prop) {
  return prop?.title?.map(t => t.plain_text).join("") || "";
}

function extractRichText(prop) {
  return prop?.rich_text?.map(t => t.plain_text).join("") || "";
}

function extractSelect(prop) {
  return prop?.select?.name || "";
}

function extractCreatedBy(prop) {
  return prop?.created_by?.name || prop?.created_by?.id || "";
}
