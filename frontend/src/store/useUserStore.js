import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useUserStore = create(
    persist(
        (set) => ({
            userId: null,
            email: null,
            role: null,
            jwt: null,

            // Set user after login

            setUser: (payload) =>
                set({
                    userId: payload.userId,
                    email: payload.email,
                    role: payload.role,
                    jwt: payload.jwt
                }),

            // Clear user on logout

            logout: () =>
                set({
                    userId: null,
                    email: null,
                    role: null,
                    jwt: null
                }),
        }),
        {
            name: "auth-storage" // stored in localStorage
        }
    )
);