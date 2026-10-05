import { type ClientSession } from "mongoose";

import {
  User,
  type IUser,
} from "../models/user.model.js";

export const findUserByEmail = async (
  organizationId: IUser["organizationId"],
  email: string,
): Promise<IUser | null> => {
  return User.findOne({
    organizationId,
    email,
  })
    .select("+passwordHash")
    .exec();
};

export const createUser = async (
  data: Pick<
    IUser,
    | "organizationId"
    | "firstName"
    | "lastName"
    | "email"
    | "passwordHash"
    | "roleIds"
  >,
  session?: ClientSession,
): Promise<IUser> => {
  const [user] = await User.create(
    [
      {
        organizationId: data.organizationId,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        passwordHash: data.passwordHash,
        roleIds: data.roleIds,
      },
    ],
    { session },
  );

  return user;
};

export const markUserEmailAsVerified = async (
  userId: string,
): Promise<boolean> => {
  const result = await User.updateOne(
    {
      _id: userId,
      status: "ACTIVE",
      emailVerified: false,
    },
    {
      $set: {
        emailVerified: true,
      },
    },
  ).exec();

  return result.modifiedCount === 1;
};


export const findUnverifiedUserByEmail = async (
  organizationId: IUser["organizationId"],
  email: string,
): Promise<IUser | null> => {
  return User.findOne({
    organizationId,
    email,
    status: "ACTIVE",
    emailVerified: false,
  }).exec();
};

export const findUserByEmailForLogin = async (
  email: string,
): Promise<IUser | null> => {
  return User.findOne({
    email,
  })
    .select("+passwordHash")
    .exec();
};


export const updateUserLastLoginAt = async (
  userId: IUser["_id"],
): Promise<void> => {
  const result = await User.updateOne(
    {
      _id: userId,
    },
    {
      $set: {
        lastLoginAt: new Date(),
      },
    },
  ).exec();

  if (result.matchedCount !== 1) {
    throw new Error(
      "Unable to update last login timestamp",
    );
  }
};

export const findUserById = async (
  userId: IUser["_id"],
  dbSession?: ClientSession,
): Promise<IUser | null> => {
  const query = User.findById(userId);

  if (dbSession) {
    query.session(dbSession);
  }

  return query.exec();
};

/*
 * Display names for a bounded set of user ids, restricted to the given
 * organization (a user of another organization is never returned).
 */
export const findUserNamesByIdsForOrganization = async (
  organizationId: IUser["organizationId"],
  userIds: IUser["_id"][],
): Promise<Map<string, string>> => {
  if (userIds.length === 0) {
    return new Map();
  }

  const users = await User.find({
    _id: { $in: userIds },
    organizationId,
  })
    .select("firstName lastName")
    .lean()
    .exec();

  return new Map(
    users.map((user) => [
      user._id.toString(),
      `${user.firstName} ${user.lastName}`.trim(),
    ]),
  );
};

/*
 * Password reset: only active, email-verified users may receive a reset
 * link. Lookup is by email alone, matching login.
 */
export const findActiveVerifiedUserByEmail = async (
  email: string,
): Promise<IUser | null> => {
  return User.findOne({
    email,
    status: "ACTIVE",
    emailVerified: true,
  }).exec();
};

export const findUserByIdWithPasswordHash = async (
  userId: IUser["_id"],
): Promise<IUser | null> => {
  return User.findById(userId)
    .select("+passwordHash")
    .exec();
};

/*
 * When expectedPasswordHash is given the update only applies if the
 * stored hash is still that value (optimistic concurrency), so two
 * simultaneous password changes cannot both succeed.
 */
export const updateUserPassword = async (
  userId: IUser["_id"],
  passwordHash: string,
  dbSession?: ClientSession,
  expectedPasswordHash?: string,
): Promise<boolean> => {
  const result = await User.updateOne(
    {
      _id: userId,
      status: "ACTIVE",
      ...(expectedPasswordHash !== undefined && {
        passwordHash: expectedPasswordHash,
      }),
    },
    {
      $set: {
        passwordHash,
        passwordChangedAt: new Date(),
      },
    },
    {
      session: dbSession,
    },
  ).exec();

  return result.modifiedCount === 1;
};
