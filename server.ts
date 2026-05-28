import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// Ensure Gemini API key is configured
const apiKey = process.env.GEMINI_API_KEY;

// Initialize the modern GoogleGenAI client on the server side
const ai = apiKey
  ? new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    })
  : null;

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json({ limit: "15mb" })); // allow larger base64 uploads for PDFs

  // API endpoint for resume analysis
  app.post("/api/analyze-resume", async (req, res) => {
    try {
      if (!ai) {
        return res.status(500).json({
          error: "Gemini API key is not configured. Please add GEMINI_API_KEY to your secrets / environment.",
        });
      }

      const { resumeText, fileBase64, fileMimeType, jobDescription, targetRole } = req.body;

      if (!resumeText && !fileBase64) {
        return res.status(400).json({ error: "No resume material provided. Paste text or upload a file." });
      }

      // Construct contents array for Gemini candidate
      const contentsParts: any[] = [];

      // 1. Add file or text resume content
      if (fileBase64 && fileMimeType) {
        const base64Data = fileBase64.replace(/^data:.*;base64,/, "");
        contentsParts.push({
          inlineData: {
            data: base64Data,
            mimeType: fileMimeType,
          },
        });
      } else if (resumeText) {
        contentsParts.push({
          text: `--- RESUME CONTENT ---\n${resumeText}\n----------------------`,
        });
      }

      // 2. Add context regarding goals, job descriptions or roles
      const jobContext = `
--- TARGET JOB DETAILS ---
Target Role / Position: ${targetRole || "Any aligned generic role"}
Job Description (Keywords match target):
${jobDescription || "No specific job description provided. Perform a general corporate ATS audit for modern industries."}
--------------------------
`;
      contentsParts.push({ text: jobContext });

      const systemPrompt = `You are an elite corporate Recruiter and Senior ATS (Applicant Tracking System) Auditor.
Your master objective is to critically assess the provided Resume against standard scanner parameters and the target Job Description context.
Provide an honest, precise, and highly detailed analysis that assigns standard industry metrics.

Verify:
- Keyword completeness: Identify actual exact matching words and high-impact industry jargon that are missing.
- Format compatibility: Detect multiple columns, floating tables, header text, unconventional fonts, bullet styles, contact details completeness, and section titles that confuse standard parser formulas.
- Impact quantification: Check if accomplishments are passive actions or defined by quantitative outcomes (e.g. STAR method).

Always return your assessment STRICTLY formatted according to the requested JSON schema.`;

      // Define the target Response Schema matches exactly what frontend expects.
      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          atsScore: {
            type: Type.INTEGER,
            description: "Overall ATS match score from 0 (failed/unreadable) to 100 (perfect keywords & structure).",
          },
          atsTier: {
            type: Type.STRING,
            description: "Tier matching the score: 'Needs Improvement' (0-49), 'Good Match' (50-79), 'Top Match' (80-100).",
          },
          roleAlignment: {
            type: Type.STRING,
            description: "The primary occupational role or career title identified from the resume alignments.",
          },
          matchedKeywords: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Exact keywords or industry-critical skills present in both resume and target job. Up to 12.",
          },
          missingKeywords: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Critical skills, technologies, methodologies, or terms explicitly highlighted in the job description that are missing or weak in the resume. Up to 12.",
          },
          formattingScore: {
            type: Type.INTEGER,
            description: "Calculated structural score from 0 to 100 evaluating parser readability.",
          },
          formattingIssues: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                issue: { type: Type.STRING, description: "Short title of issue (e.g., 'Unstructured Address Format', 'Complex Multi-column layout')." },
                severity: { type: Type.STRING, description: "'Critical' (causes parser breakage) or 'Suggestion' (minor layout preference)." },
                details: { type: Type.STRING, description: "A professional explanation of why this confuses ATS systems." },
              },
              required: ["issue", "severity", "details"],
            },
            description: "Specific layout anomalies, missing contacts, or parse block errors found. Provide empty array if perfect.",
          },
          formattingTips: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Actionable concrete design tips (e.g. 'Move contact details from headers onto the main body margin', 'Avoid text box elements'). Max 5.",
          },
          contentRecommendations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                section: { type: Type.STRING, description: "Section name such as 'Summary', 'Experience', or 'Education'." },
                recommendation: { type: Type.STRING, description: "Concrete recommendation for rewording or adding elements." },
                impact: { type: Type.STRING, description: "Priority rating: 'High', 'Medium', or 'Low'." },
              },
              required: ["section", "recommendation", "impact"],
            },
            description: "Prioritized content and phrasing improvements. Under work experience, advocate for metrics-driven sentences.",
          },
          keywordTips: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Clear tips explaining how the candidates can smoothly integrate the identified missing keywords into their work history naturally without keyword stuffing.",
          },
          alignmentSummary: {
            type: Type.STRING,
            description: "Comprehensive direct feedback describing how the resume is perceived by corporate recruiters and where the critical gaps are.",
          },
        },
        required: [
          "atsScore",
          "atsTier",
          "roleAlignment",
          "matchedKeywords",
          "missingKeywords",
          "formattingScore",
          "formattingIssues",
          "formattingTips",
          "contentRecommendations",
          "keywordTips",
          "alignmentSummary",
        ],
      };

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: contentsParts,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: responseSchema,
        },
      });

      const responseText = response.text;
      if (!responseText) {
        throw new Error("Empty response returned from Gemini API");
      }

      // Return the JSON parsed data
      return res.json(JSON.parse(responseText.trim()));
    } catch (error: any) {
      console.error("Resume Analysis failed:", error);
      return res.status(500).json({
        error: "Failed to compile the ATS resume analysis.",
        details: error.message || error,
      });
    }
  });

  // LinkedIn Auth URL Builder
  app.get("/api/linkedin/auth-url", (req, res) => {
    const origin = req.headers.referer || req.headers.origin || "http://localhost:3000";
    const redirectUri = `${origin}api/linkedin/callback`;
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      // Sandbox fallback mode
      return res.json({
        sandbox: true,
        message: "LinkedIn Dev keys not fully configured. Starting Sandbox simulator.",
        url: `/sandbox/linkedin/auth?redirect_uri=${encodeURIComponent(redirectUri)}`
      });
    }

    const state = Math.random().toString(36).substring(2, 15);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state: state,
      scope: "openid profile email",
    });
    
    const authUrl = `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
    res.json({ sandbox: false, url: authUrl });
  });

  // Sandbox LinkedIn Simulator Page
  app.get("/sandbox/linkedin/auth", (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>LinkedIn Sandbox Sign In</title>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
          <style>
            body {
              font-family: 'Inter', sans-serif;
              background-color: #f3f2ef;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              color: #191919;
            }
            .card {
              background: white;
              border-radius: 8px;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.085);
              width: 440px;
              padding: 36px;
              box-sizing: border-box;
              text-align: center;
            }
            .logo {
              font-size: 26px;
              font-weight: 700;
              color: #0a66c2;
              margin-bottom: 20px;
            }
            .title {
              font-size: 19px;
              font-weight: 600;
              margin-bottom: 8px;
              color: #1e293b;
            }
            .subtitle {
              font-size: 13px;
              color: #64748b;
              margin-bottom: 28px;
              line-height: 1.5;
            }
            .field {
              text-align: left;
              margin-bottom: 16px;
            }
            label {
              font-size: 11px;
              font-weight: 700;
              color: #475569;
              display: block;
              margin-bottom: 6px;
              text-transform: uppercase;
              letter-spacing: 0.05em;
            }
            input, select, textarea {
              width: 100%;
              padding: 10px 12px;
              border: 1px solid #cbd5e1;
              border-radius: 6px;
              font-size: 13.5px;
              box-sizing: border-box;
              font-family: 'Inter', sans-serif;
              background-color: #f8fafc;
            }
            input:focus, select:focus, textarea:focus {
              outline: none;
              border-color: #0a66c2;
              background-color: #ffffff;
            }
            button {
              width: 100%;
              background-color: #0a66c2;
              color: white;
              font-weight: 600;
              padding: 12.5px;
              border: none;
              border-radius: 28px;
              font-size: 14px;
              cursor: pointer;
              margin-top: 18px;
              transition: background-color 0.15s, box-shadow 0.15s;
            }
            button:hover {
              background-color: #004182;
              box-shadow: 0 2px 6px rgba(10, 102, 194, 0.25);
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="logo">Linked<span style="background-color: #0a66c2; color: white; border-radius: 3px; padding: 2px 6px; margin-left: 2px; font-size: 24px;">in</span></div>
            <div class="title">OAuth Sign-In Sandbox</div>
            <div class="subtitle">Complete this form to simulate a seamless high-fidelity LinkedIn authentication sync into ATSPulse.</div>
            
            <form id="authForm">
              <div class="field">
                <label>Full Name</label>
                <input type="text" id="name" value="Elena Vance" required />
              </div>
              <div class="field">
                <label>Email Address</label>
                <input type="email" id="email" value="elena.vance@example.com" required />
              </div>
              <div class="field">
                <label>Professional Title</label>
                <input type="text" id="headline" value="Senior TypeScript / React Engineer" required />
              </div>
              <div class="field">
                <label>Key Skills</label>
                <input type="text" id="skills" value="React 18+, TypeScript, Next.js, Redux Toolkit, Node.js, Express, TailwindCSS, PostgreSQL" />
              </div>
              <div class="field">
                <label>Key Achievements (starred system)</label>
                <textarea id="experience" rows="3" style="resize: none;">- Boosted checkout performance metrics by 34% through layout virtualization and cache state optimizations.
- Orchestrated transition from a legacy Angular pipeline to a modern React architecture under budget.
- Introduced CI/CD automated lint testing, trimming code review cycle delays by 4.5 hours weekly.</textarea>
              </div>
              <button type="submit">Agree & Authorize Sync</button>
            </form>
          </div>

          <script>
            document.getElementById("authForm").addEventListener("submit", function(event) {
              event.preventDefault();
              const name = document.getElementById("name").value;
              const email = document.getElementById("email").value;
              const headline = document.getElementById("headline").value;
              const skills = document.getElementById("skills").value;
              const experience = document.getElementById("experience").value;

              if (window.opener) {
                window.opener.postMessage({
                  type: "LINKEDIN_AUTH_SUCCESS",
                  profile: {
                    name,
                    email,
                    picture: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150",
                    isSandbox: true,
                    headline,
                    skills,
                    experience
                  }
                }, "*");
                window.close();
              } else {
                alert("Opener link lost. Please open LinkedIn Sign In from within the ATSPulse applet.");
              }
            });
          </script>
        </body>
      </html>
    `);
  });

  // LinkedIn Real OIDC Callback Handler
  app.get("/api/linkedin/callback", async (req, res) => {
    const { code, error, error_description } = req.query;

    if (error) {
      return res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: "LINKEDIN_AUTH_ERROR", error: "${error_description || error}" }, "*");
                window.close();
              }
            </script>
            <p>Authentication error: ${error}</p>
          </body>
        </html>
      `);
    }

    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const origin = req.headers.referer || req.headers.origin || `${req.protocol}://${req.get("host")}/`;
    const redirectUri = `${origin}api/linkedin/callback`;

    try {
      const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: redirectUri,
          client_id: clientId || "",
          client_secret: clientSecret || ""
        })
      });

      const tokenData: any = await tokenResponse.json();
      if (tokenData.error) {
        throw new Error(tokenData.error_description || tokenData.error);
      }

      const accessToken = tokenData.access_token;

      // Access UserInfo
      const profileResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      const profileData: any = await profileResponse.json();

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ 
                  type: "LINKEDIN_AUTH_SUCCESS", 
                  profile: {
                    name: "${profileData.name || (profileData.given_name + ' ' + profileData.family_name)}",
                    email: "${profileData.email || ''}",
                    picture: "${profileData.picture || ''}",
                    isSandbox: false
                  }
                }, "*");
                window.close();
              }
            </script>
            <p>Authentication successful. Transferring details...</p>
          </body>
        </html>
      `);
    } catch (err: any) {
      console.error("LinkedIn OAuth exchange failure:", err);
      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: "LINKEDIN_AUTH_ERROR", error: "${err.message || String(err)}" }, "*");
                window.close();
              }
            </script>
            <p>Exchange error: ${err.message}</p>
          </body>
        </html>
      `);
    }
  });

  // LaTeX Resume Generator
  app.post("/api/generate-latex-resume", async (req, res) => {
    try {
      if (!ai) {
        return res.status(500).json({
          error: "Gemini API key is not configured. Cannot build premium LaTeX assets."
        });
      }

      const { name, email, headline, skills, experience, targetRole, jobDescription } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Candidate identity name is required to draft a layout." });
      }

      const systemPrompt = `You are a professional resume designer and executive CV architect who specialises in crafting high-end ATS-optimized resumes in LaTeX style. 
Your objective is to generate beautifully styled, compile-ready LaTeX code for a professional resume AND a matching structured JSON representation of the content for UI previews.

CRITICAL LA-TEX FORMULAS:
1. Return standard LaTeX code inside the "latexCode" field. Do NOT use fancy third-party packages that fail to compile. Only use standard packages: article, hyperref, geometry, enumitem, titlesec, inputenc, xcolor.
2. ALWAYS properly compile and format headers. In LaTeX, escape special characters:
   - "%" is converted to "\\%"
   - "&" is converted to "\\&"
   - "$" is converted to "\\$"
   - "_" is converted to "\\_"
   - "#" is converted to "\\#"
3. Ensure work accomplishments are expanded into rich, high-impact bullets using the STAR (Situation, Task, Action, Result) format with quantifiable business metrics (e.g. "boosting page speed by 43%", "slashing server costs by $12,000 annually").
4. Tailor skills and experiences to match the targetRole and jobDescription keyword densities perfectly, while remaining true to the candidate's core skills and accomplishments, which are:
   - Headline: ${headline || "Software Engineer"}
   - Skills input: ${skills || "Full-stack Web Development"}
   - Achievements input: ${experience || "Dynamic features and product improvements"}

You MUST return your response structured according to the response Schema.`;

      const latexResponseSchema = {
        type: Type.OBJECT,
        properties: {
          latexCode: {
            type: Type.STRING,
            description: "Strictly complete, pristine, compilable LaTeX document source starting with \\documentclass and ending with \\end{document}.",
          },
          rawText: {
            type: Type.STRING,
            description: "Raw text representation of the generated resume without LaTeX codes, featuring clear section headers. This will be automatically sent to the ATS parser to evaluate the ATS score.",
          },
          resumeJson: {
            type: Type.OBJECT,
            properties: {
              personalInfo: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  email: { type: Type.STRING },
                  phone: { type: Type.STRING },
                  location: { type: Type.STRING },
                  linkedin: { type: Type.STRING },
                },
                required: ["name", "email", "phone", "location"],
              },
              summary: { type: Type.STRING },
              experience: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    company: { type: Type.STRING },
                    role: { type: Type.STRING },
                    location: { type: Type.STRING },
                    period: { type: Type.STRING },
                    bullets: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    }
                  },
                  required: ["company", "role", "location", "period", "bullets"],
                }
              },
              education: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    school: { type: Type.STRING },
                    degree: { type: Type.STRING },
                    location: { type: Type.STRING },
                    period: { type: Type.STRING }
                  },
                  required: ["school", "degree", "location", "period"],
                }
              },
              skills: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    category: { type: Type.STRING },
                    items: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    }
                  },
                  required: ["category", "items"],
                }
              }
            },
            required: ["personalInfo", "summary", "experience", "education", "skills"],
          }
        },
        required: ["latexCode", "rawText", "resumeJson"],
      };

      const userPrompt = `Draft a resume under the name of "${name}" with email "${email || "contact@example.com"}".
Target Role Context: ${targetRole || "Senior React & TypeScript Developer"}
Specific Job Guidelines & Desired Keywords:
${jobDescription || "No specific job description. Match standard modern high-frequency ATS keywords."}`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          { text: systemPrompt },
          { text: userPrompt }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: latexResponseSchema,
        }
      });

      const responseText = response.text;
      if (!responseText) {
        throw new Error("No response content from LaTeX generator.");
      }

      return res.json(JSON.parse(responseText.trim()));
    } catch (err: any) {
      console.error("LaTeX resume builder error:", err);
      return res.status(500).json({
        error: "Failed to generate premium LaTeX resume assets.",
        details: err.message || err
      });
    }
  });

  // Setup Vite development middleware OR Production static file serving
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in development mode with Vite HMR middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Serving production build from /dist...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on public accessible port ${PORT}`);
  });
}

startServer();
