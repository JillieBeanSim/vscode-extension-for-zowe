/*
* This program and the accompanying materials are made available under the terms of the *
* Eclipse Public License v2.0 which accompanies this distribution, and is available at *
* https://www.eclipse.org/legal/epl-v20.html                                      *
*                                                                                 *
* SPDX-License-Identifier: EPL-2.0                                                *
*                                                                                 *
* Copyright Contributors to the Zowe Project.                                     *
*                                                                                 *
*/

import { IProfileLoaded, Logger, CliProfileManager, IProfile, IUpdateProfile, Session } from "@zowe/imperative";
import * as path from "path";
import { URL } from "url";
import * as vscode from "vscode";
import * as globals from "./globals";
import { ZoweExplorerApiRegister } from "./api/ZoweExplorerApiRegister";
import { errorHandling, getZoweDir, FilterDescriptor, FilterItem, resolveQuickPickHelper } from "./utils";
import { IZoweTree } from "./api/IZoweTree";
import { DefaultProfileManager } from "./profiles/DefaultProfileManager";
import { IZoweNodeType, IZoweUSSTreeNode, IZoweDatasetTreeNode, IZoweJobTreeNode, IZoweTreeNode } from "./api/IZoweTreeNode";
import * as nls from "vscode-nls";

// Set up localization
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

interface IProfileValidation {
    status: string;
    name: string;
}

export enum ValidProfileEnum {
    VALID = 0,
    INVALID = -1
}
export class Profiles {
    // Processing stops if there are no profiles detected
    public static async createInstance(log: Logger): Promise<Profiles> {
        Profiles.loader = new Profiles(log);
        await Profiles.loader.refresh();
        return Profiles.loader;
    }

    public static getInstance(): Profiles { return Profiles.loader; }

    private static loader: Profiles;

    public profilesForValidation: IProfileValidation[] = [];
    public allProfiles: IProfileLoaded[] = [];
    public loadedProfile: IProfileLoaded;
    public validProfile: ValidProfileEnum = ValidProfileEnum.INVALID;
    private dsSchema: string = "Zowe-DS-Persistent";
    private ussSchema: string = "Zowe-USS-Persistent";
    private jobsSchema: string = "Zowe-Jobs-Persistent";
    private allTypes: string[];
    private profilesByType = new Map<string, IProfileLoaded[]>();
    private profileManagerByType= new Map<string, CliProfileManager>();
    private constructor(private log: Logger) {}

    public async checkCurrentProfile(profileLoaded: IProfileLoaded, prompt?: boolean): Promise<any> {
        try {
            const validSession = await ZoweExplorerApiRegister.getCommonApi(profileLoaded)
                                                              .getValidSession(profileLoaded, profileLoaded.name, null, prompt);

            if (!validSession) {
                // Credentials are invalid
                this.validProfile = ValidProfileEnum.INVALID;
                return { status: "inactive", name: profileLoaded.name, session: null };
            } else {
                // Credentials are valid
                const validStatus = await ZoweExplorerApiRegister.getCommonApi(profileLoaded).getStatus(profileLoaded, profileLoaded.type);
                if (validStatus === "inactive") {
                    // Connection details are invalid
                    this.validProfile = ValidProfileEnum.INVALID;
                    return { status: "inactive", name: profileLoaded.name, session: null };
                } else {
                    this.validProfile = ValidProfileEnum.VALID;
                    return { status: "active", name: profileLoaded.name, session: validSession };
                }
            }
        } catch (error) {
            errorHandling(error, profileLoaded.name,
                localize("checkCurrentProfile.error", "Error encountered in {0}", `checkCurrentProfile.optionalProfiles!`));
            return { status: "inactive", name: profileLoaded.name, session: null };
        }
    }

    public loadNamedProfile(name: string, type?: string): IProfileLoaded {
        for (const profile of this.allProfiles) {
            if (profile.name === name && (type ? profile.type === type : true)) { return profile; }
        }
        throw new Error(localize("loadNamedProfile.error.profileName", "Could not find profile named: {0}.", name));
    }

    public getProfiles(type: string = "zosmf"): IProfileLoaded[] { return this.profilesByType.get(type); }

    public async refresh(): Promise<void> {
        this.allProfiles = [];
        this.allTypes = [];

        // Set the default base profile (base is not a type included in registeredApiTypes)
        let profileManager = await this.getCliProfileManager("base");
        DefaultProfileManager.getInstance().setDefaultProfile("base", (await profileManager.load({ loadDefault: true })));

        // Handle all API profiles
        for (const type of ZoweExplorerApiRegister.getInstance().registeredApiTypes()) {
            profileManager = await this.getCliProfileManager(type);
            const profilesForType = await profileManager.loadAll({ typeOnly: true });
            if (profilesForType && profilesForType.length > 0) {
                this.allProfiles.push(...profilesForType);
                this.profilesByType.set(type, profilesForType);
                let defaultProfile: IProfileLoaded;

                try { defaultProfile = await profileManager.load({ loadDefault: true }); }
                catch (error) { vscode.window.showInformationMessage(error.message); }

                DefaultProfileManager.getInstance().setDefaultProfile(type, defaultProfile);
            }
            // This is in the loop because I need an instantiated profile manager config
            if (profileManager.configurations && this.allTypes.length === 0) {
                for (const element of profileManager.configurations) { this.allTypes.push(element.type); }
            }
        }
        while (this.profilesForValidation.length > 0) {
            this.profilesForValidation.pop();
        }
    }

    /**
     * Adds a new Profile to the provided treeview by clicking the 'Plus' button and
     * selecting which profile you would like to add from the drop-down that appears.
     * The profiles that are in the tree view already will not appear in the
     * drop-down.
     *
     * @export
     * @param {USSTree} zoweFileProvider - either the USS, MVS, JES tree
     */
    public async createZoweSession(zoweFileProvider: IZoweTree<IZoweTreeNode>) {
        const allProfiles = (await Profiles.getInstance()).allProfiles;
        const createNewProfile = "Create a New Connection to z/OS";
        let chosenProfile: string = "";

        // Get all profiles
        let profileNamesList = allProfiles.map((profile) => {
            return profile.name;
        });
        // Filter to list of the APIs available for current tree explorer
        profileNamesList = profileNamesList.filter((profileName) => {
            const profile = Profiles.getInstance().loadNamedProfile(profileName);
            if (zoweFileProvider.getTreeType() === globals.PersistenceSchemaEnum.USS) {
                const ussProfileTypes = ZoweExplorerApiRegister.getInstance().registeredUssApiTypes();
                return ussProfileTypes.includes(profile.type);
            }
            if (zoweFileProvider.getTreeType() === globals.PersistenceSchemaEnum.Dataset) {
                const mvsProfileTypes = ZoweExplorerApiRegister.getInstance().registeredMvsApiTypes();
                return mvsProfileTypes.includes(profile.type);
            }
            if (zoweFileProvider.getTreeType() === globals.PersistenceSchemaEnum.Job) {
                const jesProfileTypes = ZoweExplorerApiRegister.getInstance().registeredJesApiTypes();
                return jesProfileTypes.includes(profile.type);
            }
        });
        if (profileNamesList) {
            profileNamesList = profileNamesList.filter((profileName) =>
                // Find all cases where a profile is not already displayed
                !zoweFileProvider.mSessionNodes.find((sessionNode) => sessionNode.getProfileName() === profileName)
            );
        }
        const createPick = new FilterDescriptor("\uFF0B " + createNewProfile);
        const items: vscode.QuickPickItem[] = profileNamesList.map((element) => new FilterItem(element));
        const quickpick = vscode.window.createQuickPick();
        const placeholder = localize("addSession.quickPickOption",
            "Choose \"Create new...\" to define a new profile or select an existing profile to Add to the USS Explorer");

        if (globals.ISTHEIA) {
            const options: vscode.QuickPickOptions = {
                placeHolder: placeholder
            };
            // get user selection
            const choice = (await vscode.window.showQuickPick([createPick, ...items], options));
            if (!choice) {
                vscode.window.showInformationMessage(localize("enterPattern.pattern", "No selection made."));
                return;
            }
            chosenProfile = choice === createPick ? "" : choice.label;
        } else {
            quickpick.items = [createPick, ...items];
            quickpick.placeholder = placeholder;
            quickpick.ignoreFocusOut = true;
            quickpick.show();
            const choice = await resolveQuickPickHelper(quickpick);
            quickpick.hide();
            if (!choice) {
                vscode.window.showInformationMessage(localize("enterPattern.pattern", "No selection made."));
                return;
            }
            if (choice instanceof FilterDescriptor) {
                chosenProfile = "";
            } else {
                chosenProfile = choice.label;
            }
        }

        if (chosenProfile === "") {
            let newprofile: any;
            let profileName: string;
            if (quickpick.value) { profileName = quickpick.value; }

            const options = {
                placeHolder: localize("createZoweSession.option.prompt.profileName.placeholder", "Connection Name"),
                prompt: localize("createZoweSession.option.prompt.profileName", "Enter a name for the connection"),
                value: profileName
            };
            profileName = await vscode.window.showInputBox(options);
            if (!profileName) {
                vscode.window.showInformationMessage(localize("createZoweSession.enterprofileName",
                    "Profile Name was not supplied. Operation Cancelled"));
                return;
            }
            chosenProfile = profileName.trim();
            globals.LOG.debug(localize("addSession.log.debug.createNewProfile", "User created a new profile"));
            const defaultProfile = DefaultProfileManager.getInstance().getDefaultProfile("zosmf");

            try { newprofile = await Profiles.getInstance().createNewConnection(defaultProfile, chosenProfile); }
            catch (error) { await errorHandling(error, chosenProfile, error.message); }
            if (newprofile) {
                try { await Profiles.getInstance().refresh(); }
                catch (error) {
                    await errorHandling(error, newprofile, error.message);
                }
                await zoweFileProvider.addSession(newprofile);
                await zoweFileProvider.refresh();
            }
        } else if (chosenProfile) {
            globals.LOG.debug(localize("createZoweSession.log.debug.selectProfile", "User selected profile ") + chosenProfile);
            await zoweFileProvider.addSession(chosenProfile);
        } else {
            globals.LOG.debug(localize("createZoweSession.log.debug.cancelledSelection", "User cancelled profile selection"));
        }
    }

    public async editSession(profileLoaded: IProfileLoaded, profileName: string): Promise<IProfile | void> {
        const schema = await this.getSchema("zosmf");
        const updSchemaValues = await ZoweExplorerApiRegister.getCommonApi(profileLoaded)
                                                             .collectProfileDetails(null,
                                                                                    profileLoaded.profile,
                                                                                    schema);
        updSchemaValues.name = profileName;
        Object.keys(updSchemaValues).forEach((key) => {
            profileLoaded.profile[key] = updSchemaValues[key];
        });

        const newProfile = await this.updateProfile({ profile: profileLoaded.profile, name: profileName, type: profileLoaded.type });
        vscode.window.showInformationMessage(localize("editConnection.success", "Profile was successfully updated"));
        return newProfile;
    }

    public async getProfileType(): Promise<string> {
        let profileType: string;
        const profTypes = ZoweExplorerApiRegister.getInstance().registeredApiTypes();
        const typeOptions = Array.from(profTypes);
        if (typeOptions.length === 1 && typeOptions[0] === "zosmf") { profileType = typeOptions[0]; }
        else {
            const quickPickTypeOptions: vscode.QuickPickOptions = {
                placeHolder: localize("getProfileType.option.prompt.type.placeholder", "Profile Type"),
                ignoreFocusOut: true,
                canPickMany: false
            };
            profileType = await vscode.window.showQuickPick(typeOptions, quickPickTypeOptions);
        }
        return profileType;
    }

    public async getSchema(profileType: string): Promise<{}> {
        const profileManager = await this.getCliProfileManager(profileType);
        const configOptions = Array.from(profileManager.configurations);
        let schema: {};
        for (const val of configOptions) {
            if (val.type === profileType) {
                schema = val.schema.properties;
            }
        }
        return schema;
    }

    public async createNewConnection(profileLoaded: IProfileLoaded, profileName: string, requestedProfileType?: string): Promise<string | undefined> {
        const newProfileName = profileName.trim();
        if (newProfileName === undefined || newProfileName === "") {
            vscode.window.showInformationMessage(localize("createNewConnection.profileName",
                "Profile name was not supplied. Operation Cancelled"));
            return undefined;
        }

        try {
            const newProfileDetails = await ZoweExplorerApiRegister.getCommonApi(profileLoaded)
                                                                   .collectProfileDetails(null,
                                                                                          profileLoaded.profile,
                                                                                          await this.getSchema("zosmf"));
            newProfileDetails.name = newProfileName;
            newProfileDetails.type = "zosmf";
            if (!newProfileDetails.user) { delete newProfileDetails.user; }
            if (!newProfileDetails.password) { delete newProfileDetails.password; }

            for (const profile of this.allProfiles) {
                if (profile.name.toLowerCase() === profileName.toLowerCase()) {
                    vscode.window.showErrorMessage(localize("createNewConnection.duplicateProfileName",
                        "Profile name already exists. Please create a profile using a different name"));
                    return undefined;
                }
            }
            await this.saveProfile(newProfileDetails, newProfileDetails.name, newProfileDetails.type);
            vscode.window.showInformationMessage("Profile " + newProfileDetails.name + " was created.");
            return newProfileDetails.name;
        } catch (error) {
            await errorHandling(error);
        }
    }

    public async getDeleteProfile() {
        const allProfiles: IProfileLoaded[] = this.allProfiles;
        const profileNamesList = allProfiles.map((temprofile) => {
            return temprofile.name;
        });

        if (!profileNamesList.length) {
            vscode.window.showInformationMessage(localize("deleteProfile.noProfilesLoaded", "No profiles available"));
            return;
        }

        const quickPickList: vscode.QuickPickOptions = {
            placeHolder: localize("deleteProfile.quickPickOption", "Select the profile you want to delete"),
            ignoreFocusOut: true,
            canPickMany: false
        };
        const sesName = await vscode.window.showQuickPick(profileNamesList, quickPickList);

        if (sesName === undefined) {
            vscode.window.showInformationMessage(localize("deleteProfile.undefined.profilename",
                "Operation Cancelled"));
            return;
        }

        return allProfiles.find((temprofile) => temprofile.name === sesName);
    }

    public async deleteProfile(datasetTree: IZoweTree<IZoweDatasetTreeNode>, ussTree: IZoweTree<IZoweUSSTreeNode>,
                               jobsProvider: IZoweTree<IZoweJobTreeNode>, node?: IZoweNodeType) {

        let deleteLabel: string;
        let deletedProfile: IProfileLoaded;
        if (!node){ deletedProfile = await this.getDeleteProfile(); }
        else { deletedProfile = node.getProfile(); }

        if (!deletedProfile) { return; }
        deleteLabel = deletedProfile.name;

        const deleteSuccess = await this.deletePrompt(deletedProfile);
        if (!deleteSuccess){
            vscode.window.showInformationMessage(localize("deleteProfile.noSelected",
                "Operation Cancelled"));
            return;
        }

        // Delete from data det file history
        const fileHistory: string[] = datasetTree.getFileHistory();
        fileHistory.slice().reverse()
            .filter((ds) => ds.substring(1, ds.indexOf("]")).trim() === deleteLabel.toUpperCase())
            .forEach((ds) => {
                datasetTree.removeFileHistory(ds);
            });

        // Delete from Data Set Favorites
        datasetTree.mFavorites.forEach((favNode) => {
            const findNode = favNode.label.substring(1, favNode.label.indexOf("]")).trim();
            if (findNode === deleteLabel) {
                datasetTree.removeFavorite(favNode);
                favNode.dirty = true;
                datasetTree.refresh();
            }
        });

        // Delete from Data Set Tree
        datasetTree.mSessionNodes.forEach((sessNode) => {
            if (sessNode.getProfileName() === deleteLabel) {
                datasetTree.hideSession(sessNode);
                sessNode.dirty = true;
                datasetTree.refresh();
            }
        });

        // Delete from USS file history
        const fileHistoryUSS: string[] = ussTree.getFileHistory();
        fileHistoryUSS.slice().reverse()
            .filter((uss) => uss.substring(1, uss.indexOf("]")).trim()  === deleteLabel.toUpperCase())
            .forEach((uss) => {
                ussTree.removeFileHistory(uss);
            });

        // Delete from USS Favorites
        ussTree.mFavorites.forEach((ses) => {
            const findNode = ses.label.substring(1, ses.label.indexOf("]")).trim();
            if (findNode === deleteLabel) {
                ussTree.removeFavorite(ses);
                ses.dirty = true;
                ussTree.refresh();
            }
        });

        // Delete from USS Tree
        ussTree.mSessionNodes.forEach((sessNode) => {
            if (sessNode.getProfileName() === deleteLabel) {
                ussTree.hideSession(sessNode);
                sessNode.dirty = true;
                ussTree.refresh();
            }
        });

        // Delete from Jobs Favorites
        jobsProvider.mFavorites.forEach((ses) => {
            const findNode = ses.label.substring(1, ses.label.indexOf("]")).trim();
            if (findNode === deleteLabel) {
                jobsProvider.removeFavorite(ses);
                ses.dirty = true;
                jobsProvider.refresh();
            }
        });

        // Delete from Jobs Tree
        jobsProvider.mSessionNodes.forEach((jobNode) => {
            if (jobNode.getProfileName() === deleteLabel) {
                jobsProvider.hideSession(jobNode);
                jobNode.dirty = true;
                jobsProvider.refresh();
            }
        });

        // Delete from Data Set Sessions list
        const dsSetting: any = {...vscode.workspace.getConfiguration().get(this.dsSchema)};
        let sessDS: string[] = dsSetting.sessions;
        let faveDS: string[] = dsSetting.favorites;
        sessDS = sessDS.filter( (element) => {
            return element.trim() !== deleteLabel;
        });
        faveDS = faveDS.filter( (element) => {
            return element.substring(1, element.indexOf("]")).trim() !== deleteLabel;
        });
        dsSetting.sessions = sessDS;
        dsSetting.favorites = faveDS;
        await vscode.workspace.getConfiguration().update(this.dsSchema, dsSetting, vscode.ConfigurationTarget.Global);

        // Delete from USS Sessions list
        const ussSetting: any = {...vscode.workspace.getConfiguration().get(this.ussSchema)};
        let sessUSS: string[] = ussSetting.sessions;
        let faveUSS: string[] = ussSetting.favorites;
        sessUSS = sessUSS.filter( (element) => {
            return element.trim() !== deleteLabel;
        });
        faveUSS = faveUSS.filter( (element) => {
            return element.substring(1, element.indexOf("]")).trim() !== deleteLabel;
        });
        ussSetting.sessions = sessUSS;
        ussSetting.favorites = faveUSS;
        await vscode.workspace.getConfiguration().update(this.ussSchema, ussSetting, vscode.ConfigurationTarget.Global);

        // Delete from Jobs Sessions list
        const jobsSetting: any = {...vscode.workspace.getConfiguration().get(this.jobsSchema)};
        let sessJobs: string[] = jobsSetting.sessions;
        let faveJobs: string[] = jobsSetting.favorites;
        sessJobs = sessJobs.filter( (element) => {
            return element.trim() !== deleteLabel;
        });
        faveJobs = faveJobs.filter( (element) => {
            return element.substring(1, element.indexOf("]")).trim() !== deleteLabel;
        });
        jobsSetting.sessions = sessJobs;
        jobsSetting.favorites = faveJobs;
        await vscode.workspace.getConfiguration().update(this.jobsSchema, jobsSetting, vscode.ConfigurationTarget.Global);

        // Remove from list of all profiles
        const index = this.allProfiles.findIndex((deleteItem) => {
            return deleteItem === deletedProfile;
        });
        if (index >= 0) { this.allProfiles.splice(index, 1); }
    }

    public getAllTypes() { return this.allTypes; }

    public async getNamesForType(type: string) {
        const profileManager = await this.getCliProfileManager(type);
        const profilesForType = await profileManager.loadAll({ typeOnly: true });
        return profilesForType.map((profile)=> {
            return profile.name;
        });
    }

    public async directLoad(type: string, name: string): Promise<IProfileLoaded> {
        let directProfile: IProfileLoaded;
        const profileManager = await this.getCliProfileManager(type);
        if (profileManager) { directProfile = await profileManager.load({ name }); }

        return directProfile;
    }

    public async getCliProfileManager(type: string): Promise<CliProfileManager> {
        let profileManager = this.profileManagerByType.get(type);
        if (!profileManager) {
            profileManager = await new CliProfileManager({
                profileRootDirectory: path.join(getZoweDir(), "profiles"),
                type
            });
            if (profileManager) { this.profileManagerByType.set(type, profileManager); }
            else { return undefined; }
        }
        return profileManager;
    }

    private async deletePrompt(deletedProfile: IProfileLoaded) {
        const profileName = deletedProfile.name;
        this.log.debug(localize("deleteProfile.log.debug", "Deleting profile ") + profileName);
        const quickPickOptions: vscode.QuickPickOptions = {
            placeHolder: localize("deleteProfile.quickPickOption", "Delete {0}? This will permanently remove it from your system.", profileName),
            ignoreFocusOut: true,
            canPickMany: false
        };
        // confirm that the user really wants to delete
        if (await vscode.window.showQuickPick([localize("deleteProfile.showQuickPick.delete", "Delete"),
                                               localize("deleteProfile.showQuickPick.cancel", "Cancel")], quickPickOptions) !==
                                               localize("deleteProfile.showQuickPick.delete", "Delete")) {
            this.log.debug(localize("deleteProfile.showQuickPick.log.debug", "User picked Cancel. Cancelling delete of profile"));
            return;
        }

        try {
            this.deleteProfileOnDisk(deletedProfile);
        } catch (error) {
            this.log.error(localize("deleteProfile.delete.log.error", "Error encountered when deleting profile! ") + JSON.stringify(error));
            await errorHandling(error, profileName, error.message);
            throw error;
        }

        vscode.window.showInformationMessage("Profile " + profileName + " was deleted.");
        return profileName;
    }

    private async deleteProfileOnDisk(ProfileInfo) {
        let zosmfProfile: IProfile;
        try {
            zosmfProfile = await (await this.getCliProfileManager(ProfileInfo.type))
            .delete({ profile: ProfileInfo, name: ProfileInfo.name, type: ProfileInfo.type });
        } catch (error) { vscode.window.showErrorMessage(error.message); }

        return zosmfProfile.profile;
    }

    // ** Functions that Calls Get CLI Profile Manager  */

    private async updateProfile(ProfileInfo, rePrompt?: boolean): Promise<IProfile | void> {
        if (ProfileInfo.type !== undefined) {
            const profileManager = await this.getCliProfileManager(ProfileInfo.type);
            this.loadedProfile = (await profileManager.load({ name: ProfileInfo.name}));
        } else {
            for (const type of ZoweExplorerApiRegister.getInstance().registeredApiTypes()) {
                const profileManager = await this.getCliProfileManager(type);
                this.loadedProfile = (await profileManager.load({ name: ProfileInfo.name }));
            }
        }

        const OrigProfileInfo = this.loadedProfile.profile;
        const NewProfileInfo = ProfileInfo.profile;

        const profileArray = Object.keys(NewProfileInfo);
        for (const value of profileArray) {
            OrigProfileInfo[value] = NewProfileInfo[value];
            if (NewProfileInfo[value] == null) { delete OrigProfileInfo[value]; }
        }

        const updateParms: IUpdateProfile = {
            name: this.loadedProfile.name,
            merge: false,
            profile: OrigProfileInfo as IProfile
        };
        try {
            const updatedProfile = await (await this.getCliProfileManager(this.loadedProfile.type)).update(updateParms);
            return updatedProfile.profile;
        } catch (error) {
            // When no password is entered, we should silence the error message for not providing it
            // since password is optional in Zowe Explorer
            if (!error.message.includes("Must have user & password OR base64 encoded credentials")) {
                errorHandling(error);
            }
        }
    }

    private async saveProfile(ProfileInfo, ProfileName, ProfileType) {
        let newProfile: IProfile;
        try {
            newProfile = await (await this.getCliProfileManager(ProfileType)).save({ profile: ProfileInfo, name: ProfileName, type: ProfileType });
        } catch (error) {
            vscode.window.showErrorMessage(error.message);
        }
        return newProfile.profile;
    }
}
