// Roblox Studio plugin (Luau) — served as a downloadable .lua file at GET /api/roblox/plugin.lua.
// {{APP_URL}} is replaced with env.APP_URL by the server before serving.
export const ROBLOX_PLUGIN_SOURCE = `-- Yield for Roblox Studio
--
-- This is a local, unpublished Roblox Studio plugin that connects Studio to
-- Yield (a free AI web app builder). You link it ONCE: generate a link code on
-- the Yield website and paste it in here. The plugin redeems the code for a
-- permanent link to your Yield account, and from then on every place you open in
-- Studio auto-syncs by its Roblox PlaceId -- there is nothing to pair per game
-- ever again. While a place is open it pulls AI-generated Luau scripts and map
-- layouts from your Yield session and applies them, and can push the place's
-- existing scripts back to Yield so the AI can see and edit them.
--
-- NOTE: a brand-new place that has never been saved or published has a PlaceId of
-- 0, and Yield syncs by PlaceId, so save/publish the place first -- the panel will
-- tell you when it is waiting on this.
--
-- INSTALL: save this file as a .lua file and drop it directly into your local
-- Roblox Studio Plugins folder (Studio loads any .lua file placed there as a
-- plugin the next time it starts, or immediately via Plugins > Manage Plugins
-- reload, no packaging into a .rbxm required):
--   Windows: %LOCALAPPDATA%\\Roblox\\Plugins
--   Mac:     ~/Documents/Roblox/Plugins
--
-- PERMISSIONS: the first time this plugin makes an HTTP request, Studio will show
-- a one-time popup asking whether to allow HTTP requests from this local/unpublished
-- plugin -- click Allow. The first time it writes a Script's Source, Studio may show
-- a one-time "Script Injection" permission popup -- click Allow there too. Both
-- prompts are expected and required for the plugin to function; if you accidentally
-- deny one, re-run the action (Sync now / Connect) to be asked again.

local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Workspace = game:GetService("Workspace")
local Lighting = game:GetService("Lighting")
local AssetService = game:GetService("AssetService")

local API_BASE = "{{APP_URL}}" .. "/api/roblox/plugin"

-- ============================================================
-- THEME
-- ============================================================

local THEME = {
	background = Color3.fromRGB(30, 30, 34),
	panel = Color3.fromRGB(40, 40, 46),
	panelAlt = Color3.fromRGB(48, 48, 55),
	accent = Color3.fromRGB(99, 102, 241),
	accentHover = Color3.fromRGB(129, 132, 255),
	text = Color3.fromRGB(235, 235, 240),
	mutedText = Color3.fromRGB(160, 160, 170),
	danger = Color3.fromRGB(240, 100, 100),
	border = Color3.fromRGB(58, 58, 66),
}

-- ============================================================
-- SMALL UTILITIES
-- ============================================================

-- Generic Instance factory: builds an Instance, applies properties, and parents it
-- last (parenting last avoids firing change events / layout work while the instance
-- is still being configured, which is the recommended Roblox pattern).
local function new(className, props)
	local inst = Instance.new(className)
	for key, value in pairs(props) do
		if key ~= "Parent" then
			inst[key] = value
		end
	end
	if props.Parent then
		inst.Parent = props.Parent
	end
	return inst
end

local function hexToColor3(hex, fallback)
	fallback = fallback or Color3.fromRGB(255, 255, 255)
	if type(hex) ~= "string" then
		return fallback
	end
	local clean = hex:gsub("#", "")
	if #clean < 6 then
		return fallback
	end
	local r = tonumber(clean:sub(1, 2), 16)
	local g = tonumber(clean:sub(3, 4), 16)
	local b = tonumber(clean:sub(5, 6), 16)
	if not (r and g and b) then
		return fallback
	end
	return Color3.fromRGB(r, g, b)
end

-- Reads x/y/z out of a decoded-JSON table that may come in as either an object
-- ({x=.., y=.., z=..}) or an array ({1, 2, 3}), since HttpService:JSONDecode turns
-- JSON arrays into 1-indexed Lua tables.
local function xyz(t, defX, defY, defZ)
	defX, defY, defZ = defX or 0, defY or 0, defZ or 0
	if type(t) ~= "table" then
		return defX, defY, defZ
	end
	local x = t.x
	local y = t.y
	local z = t.z
	if x == nil then x = t[1] end
	if y == nil then y = t[2] end
	if z == nil then z = t[3] end
	return x or defX, y or defY, z or defZ
end

-- Reads width/depth out of a baseplate size table, same object-or-array tolerance.
local function widthDepth(t, defW, defD)
	defW, defD = defW or 512, defD or 512
	if type(t) ~= "table" then
		return defW, defD
	end
	local w = t.width or t[1]
	local d = t.depth or t[2]
	return w or defW, d or defD
end

local MATERIAL_LOOKUP = {
	plastic = Enum.Material.Plastic,
	wood = Enum.Material.Wood,
	brick = Enum.Material.Brick,
	concrete = Enum.Material.Concrete,
	metal = Enum.Material.Metal,
	grass = Enum.Material.Grass,
	sand = Enum.Material.Sand,
	neon = Enum.Material.Neon,
	glass = Enum.Material.Glass,
	forcefield = Enum.Material.ForceField,
	ice = Enum.Material.Ice,
	fabric = Enum.Material.Fabric,
	cobblestone = Enum.Material.Cobblestone,
	diamondplate = Enum.Material.DiamondPlate,
	slate = Enum.Material.Slate,
	marble = Enum.Material.Marble,
	granite = Enum.Material.Granite,
	rock = Enum.Material.Rock,
	snow = Enum.Material.Snow,
	mud = Enum.Material.Mud,
	asphalt = Enum.Material.Asphalt,
}

local function materialFromName(name)
	if type(name) ~= "string" then
		return Enum.Material.Plastic
	end
	return MATERIAL_LOOKUP[name:lower()] or Enum.Material.Plastic
end

-- "StarterPlayerScripts" (and "StarterCharacterScripts") are not real services --
-- they're fixed-name children of the StarterPlayer service -- but Yield's op paths
-- use them as if they were top-level roots for convenience. This resolves either a
-- real service name (via GetService) or one of those known aliases.
local SERVICE_ALIASES = {
	StarterPlayerScripts = function()
		return game:GetService("StarterPlayer"):WaitForChild("StarterPlayerScripts")
	end,
	StarterCharacterScripts = function()
		return game:GetService("StarterPlayer"):WaitForChild("StarterCharacterScripts")
	end,
}

local function resolveServiceRoot(name)
	local alias = SERVICE_ALIASES[name]
	if alias then
		local ok, inst = pcall(alias)
		if ok then
			return inst
		end
		return nil
	end
	local ok, inst = pcall(function()
		return game:GetService(name)
	end)
	if ok then
		return inst
	end
	return nil
end

-- ============================================================
-- STATE
-- ============================================================

local token = nil
local robloxUsername = nil

local isSyncing = false
local autoSyncRunning = false
local activityLog = {} -- newest entry at index 1, formatted strings, capped at 20

-- ============================================================
-- HTTP
-- ============================================================

-- Every network call in this plugin goes through here. Returns (ok, decodedBodyOrErrorString).
-- Never throws -- callers only ever need to check the boolean.
local function apiRequest(method, path, bodyTable)
	local headers = {
		["Content-Type"] = "application/json",
	}
	if token then
		headers["Authorization"] = "Bearer " .. token
	end

	local requestOptions = {
		Url = API_BASE .. path,
		Method = method,
		Headers = headers,
	}

	if bodyTable ~= nil then
		local encodeOk, encoded = pcall(function()
			return HttpService:JSONEncode(bodyTable)
		end)
		if not encodeOk then
			return false, "Failed to encode request body: " .. tostring(encoded)
		end
		requestOptions.Body = encoded
	end

	local requestOk, response = pcall(function()
		return HttpService:RequestAsync(requestOptions)
	end)

	if not requestOk then
		return false, "HTTP request failed (allow the HTTP request permission prompt if Studio showed one, then try again): " .. tostring(response)
	end

	if not response.Success then
		local detail = response.Body
		if detail == nil or detail == "" then
			detail = response.StatusMessage
		end
		return false, ("HTTP %s: %s"):format(tostring(response.StatusCode), tostring(detail))
	end

	if response.Body == nil or response.Body == "" then
		return true, {}
	end

	local decodeOk, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodeOk then
		return false, "Failed to parse server response: " .. tostring(decoded)
	end

	return true, decoded
end

-- ============================================================
-- PATH RESOLUTION (service/folder/.../ScriptName)
-- ============================================================

local function splitPath(path)
	local segments = {}
	for segment in string.gmatch(path or "", "[^/]+") do
		table.insert(segments, segment)
	end
	return segments
end

-- Walks an existing path without creating anything. Returns the Instance, or nil if
-- any segment along the way is missing.
local function findExistingAtPath(path)
	local segments = splitPath(path)
	if #segments < 2 then
		return nil
	end
	local current = resolveServiceRoot(segments[1])
	for i = 2, #segments do
		if not current then
			return nil
		end
		current = current:FindFirstChild(segments[i])
	end
	return current
end

-- Resolves (creating Folders as needed) the parent container for a script path.
-- Returns parent, scriptName, errorString.
local function ensureContainerForScript(path)
	local segments = splitPath(path)
	if #segments < 2 then
		return nil, nil, "Invalid path (expected service/.../ScriptName): " .. tostring(path)
	end

	local serviceName = segments[1]
	local scriptName = segments[#segments]
	local parent = resolveServiceRoot(serviceName)
	if not parent then
		return nil, nil, "Unknown Roblox service: " .. tostring(serviceName)
	end

	for i = 2, #segments - 1 do
		local folderName = segments[i]
		local child = parent:FindFirstChild(folderName)
		if not child then
			child = new("Folder", { Name = folderName, Parent = parent })
		elseif not child:IsA("Folder") then
			return nil, nil, ("Path segment '%s' exists but is not a Folder"):format(folderName)
		end
		parent = child
	end

	return parent, scriptName, nil
end

-- ============================================================
-- ACTIVITY LOG (UI is wired up further down; these just mutate state + repaint)
-- ============================================================

local renderActivityLog -- forward declaration, assigned once the UI exists

local function logActivity(message)
	table.insert(activityLog, 1, os.date("%H:%M:%S") .. "  " .. tostring(message))
	while #activityLog > 20 do
		table.remove(activityLog)
	end
	if renderActivityLog then
		renderActivityLog()
	end
end

local function clearActivityLog()
	activityLog = {}
	if renderActivityLog then
		renderActivityLog()
	end
end

-- ============================================================
-- OP HANDLERS
-- ============================================================

local function applyUpsertScript(op)
	local parent, scriptName, err = ensureContainerForScript(op.path)
	if not parent then
		error(err or ("Could not resolve path: " .. tostring(op.path)))
	end

	local className = op.className
	if className ~= "Script" and className ~= "LocalScript" and className ~= "ModuleScript" then
		className = "Script"
	end

	ChangeHistoryService:SetWaypoint("Yield sync: " .. op.path)

	local existing = parent:FindFirstChild(scriptName)
	if existing and existing.ClassName ~= className then
		-- A class mismatch is normally safe to replace (e.g. a Script that should now
		-- be a LocalScript) -- EXCEPT when the existing instance is a Folder with its
		-- own children (almost always another script's container, e.g. this path's
		-- last segment happens to collide with an earlier Folder segment). Destroying
		-- that would silently wipe everything nested under it, so refuse instead.
		if existing:IsA("Folder") and #existing:GetChildren() > 0 then
			error(("Refusing to overwrite non-empty Folder '%s' at %s with a %s -- rename one of them"):format(scriptName, op.path, className))
		end
		existing:Destroy()
		existing = nil
	end
	if not existing then
		existing = new(className, { Name = scriptName, Parent = parent })
	end
	existing.Source = op.source or ""

	ChangeHistoryService:SetWaypoint("Yield sync: " .. op.path)
	logActivity(("Applied %s (%s)"):format(op.path, className))
end

local function applyDeleteScript(op)
	local inst = findExistingAtPath(op.path)
	if inst then
		ChangeHistoryService:SetWaypoint("Yield sync: delete " .. op.path)
		inst:Destroy()
		ChangeHistoryService:SetWaypoint("Yield sync: delete " .. op.path)
		logActivity("Deleted " .. op.path)
	else
		logActivity("Nothing to delete at " .. tostring(op.path))
	end
end

-- ============================================================
-- MALICIOUS-SCRIPT SCAN
-- Free models off the Roblox marketplace very often ship with virus scripts --
-- require(assetId) backdoor loaders, loadstring payloads, HttpGet beacons, webhook
-- exfiltration, etc. EVERY model Yield inserts (whether the AI searched for it or
-- the user pasted an id) is scanned, and any script matching a known-bad signature
-- is stripped BEFORE the model is used in your game.
-- ============================================================

local SCRIPT_CLASS_NAMES = {
	Script = true,
	LocalScript = true,
	ModuleScript = true,
}

local VIRUS_SIGNATURES = {
	"require%s*%(%s*%d",   -- require(1234567) -- the classic backdoor loader
	"getfenv", "setfenv",
	"loadstring",
	"httpget", "http:get", "httpgetasync",
	"marketplaceservice",
	"getobjects",
	"queue_on_teleport", "queueonteleport",
	"firetouchinterest", "hookfunction",
	"webhook", "discord.com/api",
	"syn%.", "getgenv", "getrenv", "hookmetamethod",
}

local function scriptLooksMalicious(src)
	if type(src) ~= "string" or src == "" then
		return false, nil
	end
	local low = src:lower()
	for _, sig in ipairs(VIRUS_SIGNATURES) do
		if low:find(sig) then
			return true, sig
		end
	end
	if #src > 150000 then
		return true, "oversized script"
	end
	-- A single very long unbroken token is the hallmark of an obfuscated payload.
	local longest = 0
	for tok in src:gmatch("[%w+/=_]+") do
		if #tok > longest then
			longest = #tok
		end
	end
	if longest > 600 then
		return true, "obfuscated blob"
	end
	return false, nil
end

-- Destroys any Script/LocalScript/ModuleScript inside rootInst that matches a virus
-- signature. Returns removedCount, keptCount, flaggedNames.
local function scanAndCleanModel(rootInst)
	local removed, kept = 0, 0
	local flagged = {}
	local candidates = { rootInst }
	for _, d in ipairs(rootInst:GetDescendants()) do
		table.insert(candidates, d)
	end
	for _, d in ipairs(candidates) do
		if SCRIPT_CLASS_NAMES[d.ClassName] then
			local okSrc, src = pcall(function()
				return d.Source
			end)
			local bad, why = false, nil
			if okSrc then
				bad, why = scriptLooksMalicious(src)
			end
			if bad then
				table.insert(flagged, d.Name .. (why and (" [" .. why .. "]") or ""))
				pcall(function()
					d:Destroy()
				end)
				removed = removed + 1
			else
				kept = kept + 1
			end
		end
	end
	return removed, kept, flagged
end

-- Shared by the insert_model op and build_map's "models" list. Loads the asset,
-- unwraps InsertService's wrapper Model, positions/rotates/scales it, scans it for
-- malicious scripts, and (if tagAsMap) marks it so a later build_map with
-- clear=true can clean it up.
local function insertModel(entry, tagAsMap)
	local assetId = tonumber(entry.assetId)
	if not assetId then
		error("invalid assetId: " .. tostring(entry.assetId))
	end

	local loadOk, container = pcall(function()
		return InsertService:LoadAsset(assetId)
	end)
	if not loadOk then
		error("LoadAsset(" .. tostring(assetId) .. ") failed: " .. tostring(container))
	end

	-- LoadAsset always returns a Model wrapping the real insertable as its first
	-- child; unwrap it and discard the wrapper.
	local children = container:GetChildren()
	local instanceToUse = container
	if #children > 0 then
		instanceToUse = children[1]
		instanceToUse.Parent = Workspace
		container:Destroy()
	else
		instanceToUse.Parent = Workspace
	end

	if entry.name and entry.name ~= "" then
		instanceToUse.Name = entry.name
	end

	local px, py, pz = xyz(entry.position, 0, 0, 0)
	local rx, ry, rz = xyz(entry.rotation, 0, 0, 0)
	local targetCFrame = CFrame.new(px, py, pz) * CFrame.Angles(math.rad(rx), math.rad(ry), math.rad(rz))
	local scale = tonumber(entry.scale) or 1

	if instanceToUse:IsA("Model") then
		pcall(function()
			instanceToUse:PivotTo(targetCFrame)
		end)
		if scale ~= 1 then
			pcall(function()
				instanceToUse:ScaleTo(scale)
			end)
		end
	elseif instanceToUse:IsA("BasePart") then
		instanceToUse.CFrame = targetCFrame
		if scale ~= 1 then
			instanceToUse.Size = instanceToUse.Size * scale
		end
	end

	if tagAsMap then
		pcall(function()
			instanceToUse:SetAttribute("YieldMap", true)
		end)
	end

	-- Scan the freshly-loaded asset and strip any virus scripts before it's used.
	local removed, _, flagged = scanAndCleanModel(instanceToUse)
	if removed > 0 then
		logActivity(("Virus scan: stripped %d script(s) from '%s' (%s)"):format(removed, instanceToUse.Name, table.concat(flagged, ", ")))
	end

	return instanceToUse, removed, flagged
end

local function applyInsertModel(op)
	local inst, removed = insertModel(op, false)
	local detail = ("Inserted '%s' (id %s)"):format(inst.Name, tostring(op.assetId))
	if removed and removed > 0 then
		detail = detail .. (" -- scanned, removed %d virus script(s)"):format(removed)
	else
		detail = detail .. " -- scanned, clean"
	end
	logActivity(detail)
	return detail
end

local function applyBuildMap(op)
	local spec = op.spec
	if type(spec) ~= "table" then
		error("build_map op is missing a spec")
	end

	ChangeHistoryService:SetWaypoint("Yield build map")

	if spec.clear then
		for _, child in ipairs(Workspace:GetChildren()) do
			local ok, tagged = pcall(function()
				return child:GetAttribute("YieldMap")
			end)
			if ok and tagged == true then
				child:Destroy()
			end
		end
	end

	if type(spec.baseplate) == "table" then
		local w, d = widthDepth(spec.baseplate.size, 512, 512)
		local baseplate = Workspace:FindFirstChild("Baseplate")
		if baseplate and not baseplate:IsA("BasePart") then
			baseplate:Destroy()
			baseplate = nil
		end
		if not baseplate then
			baseplate = new("Part", { Name = "Baseplate", Parent = Workspace })
		end
		baseplate.Anchored = true
		baseplate.Size = Vector3.new(w, 2, d)
		baseplate.CFrame = CFrame.new(0, -1, 0)
		baseplate.Material = materialFromName(spec.baseplate.material)
		baseplate.Color = hexToColor3(spec.baseplate.color, Color3.fromRGB(58, 125, 58))
		baseplate.TopSurface = Enum.SurfaceType.Smooth
		baseplate.BottomSurface = Enum.SurfaceType.Smooth
		baseplate:SetAttribute("YieldMap", true)
	end

	local partCount = 0
	if type(spec.parts) == "table" then
		for _, entry in ipairs(spec.parts) do
			local ok, err = pcall(function()
				local shape = tostring(entry.shape or "Block"):lower()
				local part
				if shape == "wedge" then
					part = Instance.new("WedgePart")
				else
					part = Instance.new("Part")
					if shape == "cylinder" then
						part.Shape = Enum.PartType.Cylinder
					elseif shape == "ball" or shape == "sphere" then
						part.Shape = Enum.PartType.Ball
					else
						part.Shape = Enum.PartType.Block
					end
				end

				local sx, sy, sz = xyz(entry.size, 4, 4, 4)
				local px, py, pz = xyz(entry.position, 0, 0, 0)
				local rx, ry, rz = xyz(entry.rotation, 0, 0, 0)

				part.Name = entry.name or "Part"
				part.Size = Vector3.new(sx, sy, sz)
				part.CFrame = CFrame.new(px, py, pz) * CFrame.Angles(math.rad(rx), math.rad(ry), math.rad(rz))
				part.Color = hexToColor3(entry.color, Color3.fromRGB(163, 162, 165))
				part.Material = materialFromName(entry.material)
				part.Anchored = entry.anchored ~= false
				part.Transparency = entry.transparency or 0
				part:SetAttribute("YieldMap", true)
				part.Parent = Workspace
			end)
			if ok then
				partCount = partCount + 1
			else
				logActivity("Error building part: " .. tostring(err))
			end
		end
	end

	local modelCount = 0
	local scannedRemoved = 0
	if type(spec.models) == "table" then
		for _, entry in ipairs(spec.models) do
			local ok, removedOrErr = pcall(insertModel, entry, true)
			if ok then
				modelCount = modelCount + 1
				if type(removedOrErr) == "number" then
					scannedRemoved = scannedRemoved + removedOrErr
				end
			else
				logActivity("Error inserting model in map: " .. tostring(removedOrErr))
			end
		end
	end

	-- AI-modeled props: the AI can sculpt a detailed prop OUT OF PARTS itself (no
	-- marketplace asset needed) -- each prop is a Model whose child parts are placed
	-- relative to the prop's origin, so it can build ornate, high-detail scenery.
	local propCount = 0
	if type(spec.props) == "table" then
		for _, prop in ipairs(spec.props) do
			local ok, err = pcall(function()
				local model = new("Model", { Name = prop.name or "Prop", Parent = Workspace })
				model:SetAttribute("YieldMap", true)
				local ox, oy, oz = xyz(prop.position, 0, 0, 0)
				local pieces = prop.parts
				if type(pieces) == "table" then
					for _, entry in ipairs(pieces) do
						local shape = tostring(entry.shape or "Block"):lower()
						local part
						if shape == "wedge" then
							part = Instance.new("WedgePart")
						else
							part = Instance.new("Part")
							if shape == "cylinder" then
								part.Shape = Enum.PartType.Cylinder
							elseif shape == "ball" or shape == "sphere" then
								part.Shape = Enum.PartType.Ball
							else
								part.Shape = Enum.PartType.Block
							end
						end
						local sx, sy, sz = xyz(entry.size, 2, 2, 2)
						local px, py, pz = xyz(entry.position, 0, 0, 0)
						local rx, ry, rz = xyz(entry.rotation, 0, 0, 0)
						part.Name = entry.name or "Part"
						part.Size = Vector3.new(sx, sy, sz)
						part.CFrame = CFrame.new(ox + px, oy + py, oz + pz) * CFrame.Angles(math.rad(rx), math.rad(ry), math.rad(rz))
						part.Color = hexToColor3(entry.color, Color3.fromRGB(163, 162, 165))
						part.Material = materialFromName(entry.material)
						part.Anchored = entry.anchored ~= false
						part.Transparency = entry.transparency or 0
						part.Parent = model
					end
				end
				if model.PrimaryPart == nil then
					local firstPart = model:FindFirstChildWhichIsA("BasePart")
					if firstPart then
						model.PrimaryPart = firstPart
					end
				end
			end)
			if ok then
				propCount = propCount + 1
			else
				logActivity("Error building prop: " .. tostring(err))
			end
		end
	end

	if type(spec.lighting) == "table" then
		local lg = spec.lighting
		if lg.ambient ~= nil then
			Lighting.Ambient = hexToColor3(lg.ambient, Lighting.Ambient)
		end
		if lg.brightness ~= nil then
			Lighting.Brightness = lg.brightness
		end
		if lg.clockTime ~= nil then
			Lighting.ClockTime = lg.clockTime
		end
		if lg.fogEnd ~= nil then
			Lighting.FogEnd = lg.fogEnd
		end
	end

	ChangeHistoryService:SetWaypoint("Yield build map")
	local detail = ("Built map: %d parts, %d props, %d models"):format(partCount, propCount, modelCount)
	if scannedRemoved > 0 then
		detail = detail .. (" -- virus scan stripped %d script(s)"):format(scannedRemoved)
	end
	logActivity(detail)
	return detail
end

-- ============================================================
-- GENERIC INSTANCE EDITS (full game access -- the AI can create/edit/delete/move
-- ANY instance, not just scripts and generated maps)
-- ============================================================

-- Resolves a path, creating Folders for any missing segment along the way. Used as
-- the parent for create_instance / move_instance.
local function resolvePathCreating(path)
	local segments = splitPath(path)
	if #segments < 1 then
		return nil, "empty path"
	end
	local current = resolveServiceRoot(segments[1])
	if not current then
		return nil, "unknown service: " .. tostring(segments[1])
	end
	for i = 2, #segments do
		local child = current:FindFirstChild(segments[i])
		if not child then
			child = new("Folder", { Name = segments[i], Parent = current })
		end
		current = child
	end
	return current, nil
end

-- Coerces a decoded-JSON value to the type of the property being set, inferred from
-- the instance's CURRENT value (which exists even right after Instance.new). Handles
-- Vector3, Color3, EnumItem (incl. Material), CFrame, UDim2, number/bool/string.
local function coercePropertyValue(inst, propName, value)
	local okCur, current = pcall(function()
		return inst[propName]
	end)
	local t = okCur and typeof(current) or nil
	if t == "Vector3" then
		local x, y, z = xyz(value, current.X, current.Y, current.Z)
		return Vector3.new(tonumber(x) or 0, tonumber(y) or 0, tonumber(z) or 0)
	elseif t == "Color3" then
		if type(value) == "string" then
			return hexToColor3(value, current)
		elseif type(value) == "table" then
			local r, g, b = xyz(value, current.R * 255, current.G * 255, current.B * 255)
			return Color3.fromRGB(tonumber(r) or 0, tonumber(g) or 0, tonumber(b) or 0)
		end
		return current
	elseif t == "EnumItem" then
		if propName == "Material" and type(value) == "string" then
			return materialFromName(value)
		end
		if type(value) == "string" then
			local ok2, ev = pcall(function()
				return current.EnumType[value]
			end)
			if ok2 and ev then
				return ev
			end
		elseif type(value) == "number" then
			local ok3, ev = pcall(function()
				return current.EnumType:FromValue(value)
			end)
			if ok3 and ev then
				return ev
			end
		end
		return current
	elseif t == "CFrame" then
		if type(value) == "table" then
			local px, py, pz = xyz(value.position or value, 0, 0, 0)
			local rx, ry, rz = xyz(value.rotation, 0, 0, 0)
			return CFrame.new(px, py, pz) * CFrame.Angles(math.rad(rx), math.rad(ry), math.rad(rz))
		end
		return current
	elseif t == "UDim2" then
		if type(value) == "table" then
			return UDim2.new(
				tonumber(value.scaleX or value[1]) or 0,
				tonumber(value.offsetX or value[2]) or 0,
				tonumber(value.scaleY or value[3]) or 0,
				tonumber(value.offsetY or value[4]) or 0
			)
		end
		return current
	elseif t == "number" then
		return tonumber(value) or current
	elseif t == "boolean" then
		return value and true or false
	elseif t == "string" then
		return tostring(value)
	end
	return value
end

local function setInstanceProperties(inst, properties)
	if type(properties) ~= "table" then
		return 0
	end
	local applied = 0
	for propName, value in pairs(properties) do
		if propName ~= "Parent" and propName ~= "ClassName" then
			local coerced = coercePropertyValue(inst, propName, value)
			local ok = pcall(function()
				inst[propName] = coerced
			end)
			if ok then
				applied = applied + 1
			end
		end
	end
	return applied
end

local function applySetProperties(op)
	local inst = findExistingAtPath(op.path)
	if not inst then
		error("No instance at " .. tostring(op.path))
	end
	ChangeHistoryService:SetWaypoint("Yield edit: " .. tostring(op.path))
	local n = setInstanceProperties(inst, op.properties)
	ChangeHistoryService:SetWaypoint("Yield edit: " .. tostring(op.path))
	local detail = ("Set %d propert%s on %s"):format(n, n == 1 and "y" or "ies", op.path)
	logActivity(detail)
	return detail
end

local function applyCreateInstance(op)
	local className = tostring(op.className or "")
	if className == "" then
		error("create_instance needs a className")
	end
	local parent, err = resolvePathCreating(op.parent)
	if not parent then
		error(err or ("bad parent: " .. tostring(op.parent)))
	end
	ChangeHistoryService:SetWaypoint("Yield create: " .. className)
	local okNew, inst = pcall(function()
		return Instance.new(className)
	end)
	if not okNew then
		error("Cannot create a " .. className .. ": " .. tostring(inst))
	end
	if op.name and op.name ~= "" then
		inst.Name = op.name
	end
	setInstanceProperties(inst, op.properties)
	inst.Parent = parent
	ChangeHistoryService:SetWaypoint("Yield create: " .. className)
	local detail = ("Created %s '%s' in %s"):format(className, inst.Name, tostring(op.parent))
	logActivity(detail)
	return detail
end

local function applyDeleteInstance(op)
	local inst = findExistingAtPath(op.path)
	if inst then
		ChangeHistoryService:SetWaypoint("Yield delete: " .. op.path)
		inst:Destroy()
		ChangeHistoryService:SetWaypoint("Yield delete: " .. op.path)
		logActivity("Deleted " .. op.path)
		return "Deleted " .. op.path
	end
	logActivity("Nothing to delete at " .. tostring(op.path))
	return "Nothing to delete at " .. tostring(op.path)
end

local function applyRenameInstance(op)
	local inst = findExistingAtPath(op.path)
	if not inst then
		error("No instance at " .. tostring(op.path))
	end
	if not op.name or op.name == "" then
		error("rename_instance needs a name")
	end
	ChangeHistoryService:SetWaypoint("Yield rename")
	inst.Name = tostring(op.name)
	local detail = ("Renamed %s -> %s"):format(op.path, op.name)
	logActivity(detail)
	return detail
end

local function applyMoveInstance(op)
	local inst = findExistingAtPath(op.path)
	if not inst then
		error("No instance at " .. tostring(op.path))
	end
	local parent, err = resolvePathCreating(op.parent)
	if not parent then
		error(err or "bad parent")
	end
	ChangeHistoryService:SetWaypoint("Yield move")
	inst.Parent = parent
	local detail = ("Moved %s -> %s"):format(op.path, tostring(op.parent))
	logActivity(detail)
	return detail
end

-- Builds a MeshPart LOCALLY from raw geometry via EditableMesh — NO asset upload, NO
-- publishing, NO Open Cloud key. This is how Yield inserts AI-3D-generated meshes
-- without needing the user to publish anything: the server parses the generated .glb
-- into vertices + triangles and sends them here.
local function applyCreateMesh(op)
	local verts = op.verts
	local tris = op.tris
	if type(verts) ~= "table" or type(tris) ~= "table" or #verts < 9 or #tris < 3 then
		error("create_mesh: missing geometry")
	end

	ChangeHistoryService:SetWaypoint("Yield build mesh")

	-- EditableMesh creation moved from Instance.new to AssetService over Studio
	-- versions — try the current API first, then the older one.
	local okEM, em = pcall(function()
		return AssetService:CreateEditableMesh()
	end)
	if not okEM or not em then
		okEM, em = pcall(function()
			return Instance.new("EditableMesh")
		end)
	end
	if not okEM or not em then
		error("EditableMesh isn't available — update Roblox Studio to a recent version. (" .. tostring(em) .. ")")
	end

	local ids = {}
	local n = math.floor(#verts / 3)
	for i = 0, n - 1 do
		ids[i] = em:AddVertex(Vector3.new(verts[i * 3 + 1], verts[i * 3 + 2], verts[i * 3 + 3]))
	end

	local t = math.floor(#tris / 3)
	local added = 0
	for i = 0, t - 1 do
		local a = ids[tris[i * 3 + 1]]
		local b = ids[tris[i * 3 + 2]]
		local c = ids[tris[i * 3 + 3]]
		if a and b and c then
			if pcall(function() em:AddTriangle(a, b, c) end) then
				added = added + 1
			end
		end
	end
	if added == 0 then
		error("create_mesh: no valid triangles could be built")
	end

	-- CreateMeshPartAsync takes a Content wrapper on current Studio, or the
	-- EditableMesh directly on older builds.
	local okMP, meshPart = pcall(function()
		if Content and Content.fromObject then
			return AssetService:CreateMeshPartAsync(Content.fromObject(em), { CollisionFidelity = Enum.CollisionFidelity.Box })
		end
		return AssetService:CreateMeshPartAsync(em)
	end)
	if not okMP or not meshPart then
		error("CreateMeshPartAsync failed: " .. tostring(meshPart))
	end

	local scale = tonumber(op.scale) or 1
	if scale ~= 1 then
		pcall(function()
			meshPart.Size = meshPart.Size * scale
		end)
	end
	meshPart.Name = op.name or "Mesh"
	meshPart.Anchored = true
	meshPart.Color = hexToColor3(op.color, Color3.fromRGB(183, 176, 164))
	local px, py, pz = xyz(op.position, 0, 5, 0)
	meshPart.CFrame = CFrame.new(px, py, pz)
	pcall(function()
		meshPart:SetAttribute("YieldMap", true)
	end)
	meshPart.Parent = Workspace

	ChangeHistoryService:SetWaypoint("Yield build mesh")
	local detail = ("Built mesh '%s' locally — %d verts, %d tris (no upload)"):format(meshPart.Name, n, added)
	logActivity(detail)
	return detail
end

-- ============================================================
-- SYNC (pull -> apply -> ack)
-- ============================================================

local setStatusLabel -- forward declaration, assigned once the UI exists
local pushSnapshot -- forward declaration (assigned below); used by the auto-sync loop + link
local handleAuthRevoked -- forward declaration; clears a dead session and shows the link view

local function performSync()
	if isSyncing or not token then
		return
	end
	isSyncing = true

	-- Yield syncs whatever place is currently open, keyed by its Roblox PlaceId. A
	-- brand-new unsaved/unpublished place has PlaceId 0, which can't be synced --
	-- bail out gracefully (no error spam) and tell the user what to do.
	local placeId = tostring(game.PlaceId)
	local placeName = game.Name
	if game.PlaceId == 0 then
		if setStatusLabel then
			setStatusLabel("Open or publish this place first -- it needs a PlaceId to sync.")
		end
		isSyncing = false
		return
	end

	local pullOk, body = apiRequest(
		"GET",
		"/pull?placeId=" .. HttpService:UrlEncode(placeId) .. "&placeName=" .. HttpService:UrlEncode(placeName),
		nil
	)
	if not pullOk then
		-- HTTP 401 = this session's token was revoked (web-side unlink, or a NEW link
		-- replaced it — one code = one link). Don't retry forever with a dead token:
		-- clear the session and show the link view for a fresh code.
		if tostring(body):find("HTTP 401", 1, true) and handleAuthRevoked then
			isSyncing = false
			handleAuthRevoked()
			return
		end
		logActivity("Sync failed: " .. tostring(body))
		if setStatusLabel then
			setStatusLabel("Connected - last sync failed, will retry")
		end
		isSyncing = false
		return
	end

	-- apiRequest returns (true, {}) for an empty body, but a literal JSON "null"
	-- response would decode to Lua nil -- guard before indexing it below.
	if type(body) ~= "table" then
		logActivity("Sync failed: unexpected empty response from Yield")
		if setStatusLabel then
			setStatusLabel("Connected - last sync failed, will retry")
		end
		isSyncing = false
		return
	end

	-- Prefer the project title the server maps this place to, otherwise just show
	-- the place's own name.
	local displayName = placeName
	if type(body.project) == "table" and body.project.title and body.project.title ~= "" then
		displayName = body.project.title
	end

	local ops = body.ops
	if type(ops) ~= "table" or #ops == 0 then
		if setStatusLabel then
			setStatusLabel(("Synced • %s"):format(displayName))
		end
		isSyncing = false
		return
	end

	local results = {}
	for _, op in ipairs(ops) do
		local detail = nil
		local opOk, opErr = pcall(function()
			if op.type == "upsert_script" then
				applyUpsertScript(op)
			elseif op.type == "delete_script" then
				applyDeleteScript(op)
			elseif op.type == "build_map" then
				detail = applyBuildMap(op)
			elseif op.type == "insert_model" then
				detail = applyInsertModel(op)
			elseif op.type == "create_mesh" then
				detail = applyCreateMesh(op)
			elseif op.type == "set_properties" then
				detail = applySetProperties(op)
			elseif op.type == "create_instance" then
				detail = applyCreateInstance(op)
			elseif op.type == "delete_instance" then
				detail = applyDeleteInstance(op)
			elseif op.type == "rename_instance" then
				detail = applyRenameInstance(op)
			elseif op.type == "move_instance" then
				detail = applyMoveInstance(op)
			else
				error("Unknown op type: " .. tostring(op.type))
			end
		end)

		if opOk then
			table.insert(results, { id = op.id, ok = true, detail = detail })
		else
			table.insert(results, { id = op.id, ok = false, detail = tostring(opErr) })
			logActivity(("Error (%s): %s"):format(tostring(op.type), tostring(opErr)))
		end
	end

	-- Always report back, even on partial failure -- the server needs to know which
	-- ops landed so it doesn't resend them forever.
	local ackOk, ackErr = apiRequest("POST", "/ack", {
		placeId = placeId,
		placeName = placeName,
		results = results,
	})
	if not ackOk then
		logActivity("Failed to report sync results to Yield: " .. tostring(ackErr))
	end

	if setStatusLabel then
		setStatusLabel(("Synced • %s"):format(displayName))
	end
	isSyncing = false
end

local function startAutoSyncLoop(widget)
	if autoSyncRunning then
		return
	end
	autoSyncRunning = true
	task.spawn(function()
		local cycle = 0
		while autoSyncRunning and token and widget.Enabled do
			-- pcall-wrapped so ANY uncaught error inside performSync (not just the
			-- per-op pcalls it already has) can't kill this coroutine and leave
			-- autoSyncRunning stuck true forever (which would silently block every
			-- future "Sync now" / auto-sync attempt until Studio restarts).
			local ok, err = pcall(performSync)
			if not ok then
				isSyncing = false
				logActivity("Auto-sync error: " .. tostring(err))
			end
			-- Every ~2 minutes, push a fresh whole-game snapshot so Yield's AI always
			-- has a current read of the place (map + code) to reason over and edit.
			cycle = cycle + 1
			if cycle % 6 == 0 and pushSnapshot then
				pcall(pushSnapshot)
			end
			task.wait(20)
		end
		autoSyncRunning = false
	end)
end

local function stopAutoSyncLoop()
	autoSyncRunning = false
end

-- ============================================================
-- PUSH SNAPSHOT (send existing scripts in the place up to Yield)
-- ============================================================

-- Matches Yield's VALID_ROOTS exactly (src/lib/roblox.ts) -- every service an AI
-- or manual edit is allowed to write a script into is also scanned here, so a
-- script placed under e.g. Workspace or Lighting doesn't silently never push back.
local PUSH_ROOTS = {
	"Workspace",
	"ServerScriptService",
	"ServerStorage",
	"ReplicatedStorage",
	"StarterPlayerScripts",
	"StarterGui",
	"StarterPack",
	"StarterCharacterScripts",
	"Lighting",
}

local MAX_PUSH_SCRIPTS = 300
-- Whole-game read: how many instances (map + everything) to send up so the AI can
-- "see" the full game and target real paths when it edits.
local MAX_TREE_NODES = 1200

local function pathForInstance(inst, rootName, rootInstance)
	local segments = {}
	local current = inst
	while current and current ~= rootInstance do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end
	return rootName .. "/" .. table.concat(segments, "/")
end

local function collectScriptsForPush()
	local scripts = {}
	local truncated = false

	for _, rootName in ipairs(PUSH_ROOTS) do
		local rootInstance = resolveServiceRoot(rootName)
		if rootInstance then
			for _, descendant in ipairs(rootInstance:GetDescendants()) do
				if #scripts >= MAX_PUSH_SCRIPTS then
					truncated = true
					break
				end
				if SCRIPT_CLASS_NAMES[descendant.ClassName] then
					local ok, source = pcall(function()
						return descendant.Source
					end)
					if ok then
						table.insert(scripts, {
							path = pathForInstance(descendant, rootName, rootInstance),
							className = descendant.ClassName,
							source = source,
						})
					end
				end
			end
		end
		if #scripts >= MAX_PUSH_SCRIPTS then
			truncated = true
			break
		end
	end

	return scripts, truncated
end

-- Compact summary of one instance for the whole-game tree: path + class, plus key
-- geometry for parts so the AI understands the map's layout (sizes/positions/colors).
local function summarizeInstance(inst, rootName, rootInstance)
	local node = {
		path = pathForInstance(inst, rootName, rootInstance),
		className = inst.ClassName,
	}
	if inst:IsA("BasePart") then
		pcall(function()
			local round = function(n) return math.floor(n * 100 + 0.5) / 100 end
			node.props = {
				size = { round(inst.Size.X), round(inst.Size.Y), round(inst.Size.Z) },
				position = { round(inst.Position.X), round(inst.Position.Y), round(inst.Position.Z) },
				material = inst.Material.Name,
				color = ("#%02X%02X%02X"):format(
					math.floor(inst.Color.R * 255 + 0.5),
					math.floor(inst.Color.G * 255 + 0.5),
					math.floor(inst.Color.B * 255 + 0.5)
				),
				anchored = inst.Anchored,
			}
		end)
	end
	return node
end

-- Walks the whole game (every PUSH_ROOT service) into a flat, capped list of
-- instances -- the map, models, GUIs, folders, and scripts alike -- so Yield has a
-- complete read of the game to reason over and edit.
local function collectGameTree()
	local nodes = {}
	local truncated = false
	for _, rootName in ipairs(PUSH_ROOTS) do
		local rootInstance = resolveServiceRoot(rootName)
		if rootInstance then
			for _, descendant in ipairs(rootInstance:GetDescendants()) do
				if #nodes >= MAX_TREE_NODES then
					truncated = true
					break
				end
				table.insert(nodes, summarizeInstance(descendant, rootName, rootInstance))
			end
		end
		if #nodes >= MAX_TREE_NODES then
			truncated = true
			break
		end
	end
	return nodes, truncated
end

function pushSnapshot()
	-- Same PlaceId 0 caveat as performSync: an unsaved/unpublished place has no id
	-- to key the snapshot to, so don't push -- just tell the user.
	if game.PlaceId == 0 then
		if setStatusLabel then
			setStatusLabel("Open or publish this place first -- it needs a PlaceId to sync.")
		end
		logActivity("Can't push yet: save or publish this place so it has a PlaceId.")
		return
	end

	local scripts, truncated = collectScriptsForPush()
	if truncated then
		logActivity("Warning: this place has more than " .. MAX_PUSH_SCRIPTS .. " scripts, only pushing the first " .. MAX_PUSH_SCRIPTS)
	end

	local tree, treeTruncated = collectGameTree()

	local ok, body = apiRequest("POST", "/snapshot", {
		scripts = scripts,
		tree = tree,
		treeTruncated = treeTruncated,
		placeId = tostring(game.PlaceId),
		placeName = game.Name,
	})

	if ok then
		logActivity(("Pushed %d scripts + %d instances to Yield"):format(#scripts, #tree))
	elseif tostring(body):find("HTTP 401", 1, true) and handleAuthRevoked then
		handleAuthRevoked()
	else
		logActivity("Push failed: " .. tostring(body))
	end
end

-- ============================================================
-- UI
-- ============================================================

local toolbar = plugin:CreateToolbar("Yield")
local toggleButton = toolbar:CreateButton(
	"YieldToggle",
	"Open the Yield panel to sync AI-generated scripts and maps",
	"",
	"Yield"
)

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 400, 260, 300)
local widget = plugin:CreateDockWidgetPluginGui("YieldRobloxPanel", widgetInfo)
widget.Title = "Yield"
widget.Name = "YieldRobloxPanel"

local root = new("Frame", {
	BackgroundColor3 = THEME.background,
	BorderSizePixel = 0,
	Size = UDim2.fromScale(1, 1),
	Parent = widget,
})

-- ---------- Pairing page ----------

local pairingPage = new("Frame", {
	BackgroundTransparency = 1,
	Size = UDim2.fromScale(1, 1),
	Parent = root,
})

new("TextLabel", {
	Font = Enum.Font.GothamBold,
	Text = "Connect to Yield",
	TextSize = 18,
	TextColor3 = THEME.text,
	TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 14),
	Size = UDim2.new(1, -28, 0, 24),
	Parent = pairingPage,
})

new("TextLabel", {
	Font = Enum.Font.Gotham,
	Text = "Generate an 8-character link code on the Yield website and paste it below. This links Studio to your Yield account one time -- after that, every place you open here auto-syncs on its own. You never need to pair per game again.",
	TextSize = 13,
	TextColor3 = THEME.mutedText,
	TextWrapped = true,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 42),
	Size = UDim2.new(1, -28, 0, 72),
	Parent = pairingPage,
})

local codeBox = new("TextBox", {
	Font = Enum.Font.GothamBold,
	PlaceholderText = "ABCD1234",
	PlaceholderColor3 = THEME.mutedText,
	Text = "",
	TextSize = 16,
	TextColor3 = THEME.text,
	ClearTextOnFocus = false,
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 14, 0, 120),
	Size = UDim2.new(1, -28, 0, 36),
	Parent = pairingPage,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = codeBox })
new("UIStroke", { Color = THEME.border, Thickness = 1, Parent = codeBox })
new("UIPadding", {
	PaddingLeft = UDim.new(0, 10),
	PaddingRight = UDim.new(0, 10),
	Parent = codeBox,
})

local connectButton = new("TextButton", {
	Font = Enum.Font.GothamBold,
	Text = "Connect",
	TextSize = 15,
	TextColor3 = Color3.fromRGB(255, 255, 255),
	BackgroundColor3 = THEME.accent,
	AutoButtonColor = true,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 14, 0, 164),
	Size = UDim2.new(1, -28, 0, 36),
	Parent = pairingPage,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = connectButton })

local pairStatusLabel = new("TextLabel", {
	Font = Enum.Font.Gotham,
	Text = "",
	TextSize = 12,
	TextColor3 = THEME.mutedText,
	TextWrapped = true,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 208),
	Size = UDim2.new(1, -28, 0, 60),
	Parent = pairingPage,
})

-- ---------- Connected page ----------

local connectedPage = new("Frame", {
	BackgroundTransparency = 1,
	Size = UDim2.fromScale(1, 1),
	Visible = false,
	Parent = root,
})

new("TextLabel", {
	Font = Enum.Font.GothamBold,
	Text = "Connected to Yield",
	TextSize = 17,
	TextColor3 = THEME.text,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextTruncate = Enum.TextTruncate.AtEnd,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 10),
	Size = UDim2.new(1, -28, 0, 22),
	Parent = connectedPage,
})

local userLabel = new("TextLabel", {
	Font = Enum.Font.Gotham,
	Text = "Connected",
	TextSize = 12,
	TextColor3 = THEME.mutedText,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextTruncate = Enum.TextTruncate.AtEnd,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 34),
	Size = UDim2.new(1, -28, 0, 16),
	Parent = connectedPage,
})

local statusLabel = new("TextLabel", {
	Font = Enum.Font.Gotham,
	Text = "Waiting for first sync...",
	TextSize = 12,
	TextColor3 = THEME.mutedText,
	TextWrapped = true,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 52),
	Size = UDim2.new(1, -28, 0, 30),
	Parent = connectedPage,
})

local actionsRow = new("Frame", {
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 86),
	Size = UDim2.new(1, -28, 0, 32),
	Parent = connectedPage,
})
new("UIListLayout", {
	FillDirection = Enum.FillDirection.Horizontal,
	Padding = UDim.new(0, 8),
	SortOrder = Enum.SortOrder.LayoutOrder,
	Parent = actionsRow,
})

local syncButton = new("TextButton", {
	Font = Enum.Font.GothamBold,
	Text = "Sync now",
	TextSize = 13,
	TextColor3 = Color3.fromRGB(255, 255, 255),
	BackgroundColor3 = THEME.accent,
	BorderSizePixel = 0,
	Size = UDim2.new(0.55, -4, 1, 0),
	LayoutOrder = 1,
	Parent = actionsRow,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = syncButton })

local pushButton = new("TextButton", {
	Font = Enum.Font.GothamBold,
	Text = "Push game",
	TextSize = 13,
	TextColor3 = THEME.text,
	BackgroundColor3 = THEME.panelAlt,
	BorderSizePixel = 0,
	Size = UDim2.new(0.45, -4, 1, 0),
	LayoutOrder = 2,
	Parent = actionsRow,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = pushButton })

local disconnectButton = new("TextButton", {
	Font = Enum.Font.Gotham,
	Text = "Disconnect",
	TextSize = 12,
	TextColor3 = THEME.danger,
	BackgroundTransparency = 1,
	AutoButtonColor = false,
	Position = UDim2.new(0, 14, 0, 124),
	Size = UDim2.new(1, -28, 0, 18),
	Parent = connectedPage,
})

new("TextLabel", {
	Font = Enum.Font.GothamBold,
	Text = "Activity",
	TextSize = 12,
	TextColor3 = THEME.mutedText,
	TextXAlignment = Enum.TextXAlignment.Left,
	BackgroundTransparency = 1,
	Position = UDim2.new(0, 14, 0, 150),
	Size = UDim2.new(1, -28, 0, 16),
	Parent = connectedPage,
})

local logScroll = new("ScrollingFrame", {
	BackgroundColor3 = THEME.panel,
	BorderSizePixel = 0,
	Position = UDim2.new(0, 14, 0, 170),
	Size = UDim2.new(1, -28, 1, -182),
	ScrollingDirection = Enum.ScrollingDirection.Y,
	ScrollBarThickness = 6,
	ScrollBarImageColor3 = THEME.accent,
	CanvasSize = UDim2.new(0, 0, 0, 0),
	AutomaticCanvasSize = Enum.AutomaticSize.Y,
	Parent = connectedPage,
})
new("UICorner", { CornerRadius = UDim.new(0, 6), Parent = logScroll })
new("UIPadding", {
	PaddingLeft = UDim.new(0, 8),
	PaddingRight = UDim.new(0, 8),
	PaddingTop = UDim.new(0, 6),
	PaddingBottom = UDim.new(0, 6),
	Parent = logScroll,
})
new("UIListLayout", {
	Padding = UDim.new(0, 4),
	SortOrder = Enum.SortOrder.LayoutOrder,
	Parent = logScroll,
})

renderActivityLog = function()
	for _, child in ipairs(logScroll:GetChildren()) do
		if child:IsA("TextLabel") then
			child:Destroy()
		end
	end
	for i, line in ipairs(activityLog) do
		local lowered = line:lower()
		local isProblem = lowered:find("error") ~= nil or lowered:find("fail") ~= nil
		new("TextLabel", {
			Font = Enum.Font.Code,
			Text = line,
			TextSize = 12,
			TextColor3 = isProblem and THEME.danger or THEME.mutedText,
			TextWrapped = true,
			TextXAlignment = Enum.TextXAlignment.Left,
			BackgroundTransparency = 1,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.new(1, 0, 0, 0),
			LayoutOrder = i,
			Parent = logScroll,
		})
	end
end

-- ============================================================
-- VIEW STATE / SETTINGS HELPERS
-- ============================================================

setStatusLabel = function(text)
	statusLabel.Text = text
end

local function updateUserLabel()
	if type(robloxUsername) == "string" and robloxUsername ~= "" then
		userLabel.Text = "Signed in as " .. robloxUsername
	else
		userLabel.Text = "Connected"
	end
end

local function showPairingView()
	connectedPage.Visible = false
	pairingPage.Visible = true
	pairStatusLabel.Text = ""
	codeBox.Text = ""
end

local function showConnectedView()
	pairingPage.Visible = false
	connectedPage.Visible = true
	updateUserLabel()
	statusLabel.Text = "Connected - waiting for first sync..."
end

local function saveSession(newToken, newRobloxUsername)
	token = newToken
	robloxUsername = newRobloxUsername
	plugin:SetSetting("yield_token", token)
	plugin:SetSetting("yield_roblox_user", robloxUsername)
end

local function clearSession()
	token = nil
	robloxUsername = nil
	plugin:SetSetting("yield_token", nil)
	plugin:SetSetting("yield_roblox_user", nil)
end

-- Called when the server answers 401: this install's session was revoked (unlinked
-- from the website, or replaced by a newer link — one code = one link). Clears the
-- dead token and returns to the link view instead of failing silently forever.
handleAuthRevoked = function()
	stopAutoSyncLoop()
	clearSession()
	clearActivityLog()
	showPairingView()
	pairStatusLabel.Text = "This Studio was unlinked from Yield -- get a new link code from the website to reconnect."
	pairStatusLabel.TextColor3 = THEME.danger
end

-- ============================================================
-- WIRING
-- ============================================================

local function onWidgetEnabledChanged()
	toggleButton:SetActive(widget.Enabled)
	if widget.Enabled and token then
		startAutoSyncLoop(widget)
	else
		stopAutoSyncLoop()
	end
end

local function attemptLink(rawCode)
	local code = (rawCode or ""):gsub("%s", ""):upper()
	if #code == 0 then
		pairStatusLabel.Text = "Please enter your link code."
		pairStatusLabel.TextColor3 = THEME.danger
		return
	end

	connectButton.Text = "Linking..."
	pairStatusLabel.Text = "Linking to Yield..."
	pairStatusLabel.TextColor3 = THEME.mutedText

	-- Link is a one-time exchange of the code for a permanent, account-scoped token.
	-- No placeId/placeName here -- places are picked up automatically once linked.
	local ok, body = apiRequest("POST", "/link", {
		code = code,
	})

	connectButton.Text = "Connect"

	if not ok then
		pairStatusLabel.Text = "Could not link: " .. tostring(body) .. ". If Studio asked to allow HTTP requests, allow it and try again."
		pairStatusLabel.TextColor3 = THEME.danger
		return
	end

	if type(body) ~= "table" or not body.token then
		pairStatusLabel.Text = "Unexpected response from Yield. Check the code and try again."
		pairStatusLabel.TextColor3 = THEME.danger
		return
	end

	saveSession(body.token, body.robloxUsername)
	clearActivityLog()
	showConnectedView()
	if type(robloxUsername) == "string" and robloxUsername ~= "" then
		logActivity("Linked to Yield as " .. robloxUsername)
	else
		logActivity("Linked to Yield")
	end
	onWidgetEnabledChanged()
	-- Immediately give Yield a full read of this game (map + code) so the AI can
	-- start reasoning over what's actually here.
	task.spawn(function()
		pcall(pushSnapshot)
	end)
end

local function disconnect()
	apiRequest("POST", "/unlink", {}) -- best-effort; local state is cleared regardless
	stopAutoSyncLoop()
	clearSession()
	clearActivityLog()
	showPairingView()
end

connectButton.MouseButton1Click:Connect(function()
	attemptLink(codeBox.Text)
end)

codeBox.FocusLost:Connect(function(enterPressed)
	if enterPressed then
		attemptLink(codeBox.Text)
	end
end)

syncButton.MouseButton1Click:Connect(function()
	task.spawn(function()
		syncButton.Text = "Syncing..."
		local ok, err = pcall(performSync)
		if not ok then
			isSyncing = false
			logActivity("Sync error: " .. tostring(err))
		end
		syncButton.Text = "Sync now"
	end)
end)

pushButton.MouseButton1Click:Connect(function()
	task.spawn(function()
		pushButton.Text = "Pushing..."
		local ok, err = pcall(pushSnapshot)
		if not ok then
			logActivity("Push error: " .. tostring(err))
		end
		pushButton.Text = "Push game"
	end)
end)

disconnectButton.MouseButton1Click:Connect(disconnect)

toggleButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

widget:GetPropertyChangedSignal("Enabled"):Connect(onWidgetEnabledChanged)

-- ============================================================
-- BOOTSTRAP
-- ============================================================

local savedToken = plugin:GetSetting("yield_token")
local savedRobloxUser = plugin:GetSetting("yield_roblox_user")

if type(savedToken) == "string" and #savedToken > 0 then
	token = savedToken
	if type(savedRobloxUser) == "string" then
		robloxUsername = savedRobloxUser
	end
	showConnectedView()
else
	showPairingView()
end

renderActivityLog()
onWidgetEnabledChanged()
`;

export default ROBLOX_PLUGIN_SOURCE;
