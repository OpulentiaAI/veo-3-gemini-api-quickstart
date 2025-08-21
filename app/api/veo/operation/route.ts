import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const name = body.name as string | undefined;

    if (!name) {
      return NextResponse.json(
        { error: "Missing operation name" },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfigured: GEMINI_API_KEY is not set" },
        { status: 500 }
      );
    }

    // Poll operation status via REST to be compatible across SDK versions
    // The operation name typically looks like: "operations/xxxxxxxx"
    const url = `https://generativelanguage.googleapis.com/v1beta/${name}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "x-goog-api-key": apiKey,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return NextResponse.json(
        {
          error: `Upstream operation poll failed: ${resp.status} ${resp.statusText}`,
          details: text,
        },
        { status: 502 }
      );
    }

    const fresh = await resp.json();
    return NextResponse.json(fresh);
  } catch (error) {
    console.error("Error polling operation:", error);
    return NextResponse.json(
      { error: "Failed to poll operation" },
      { status: 500 }
    );
  }
}
